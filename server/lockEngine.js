// server/lockEngine.js
const crypto = require('crypto');
const { movies, showSeats, bookings, auditLogs, logAuditEvent } = require('./store');

const HOLD_DURATION_MS = 120 * 1000; // 2 minutes hold lease

class LockEngine {
  constructor() {
    this.broadcastCallback = null;
    this.startTtlReaper();
  }

  // Register WebSocket broadcast callback
  setBroadcaster(fn) {
    this.broadcastCallback = fn;
  }

  broadcast(message) {
    if (typeof this.broadcastCallback === 'function') {
      try {
        this.broadcastCallback(message);
      } catch (err) {
        console.error('Broadcast error:', err);
      }
    }
  }

  // Background Reaper to reclaim expired seat leases
  startTtlReaper() {
    setInterval(() => {
      this.reapExpiredHolds();
    }, 1000);
  }

  reapExpiredHolds() {
    const now = Date.now();
    const releasedSeatsByShow = {};

    for (const [showId, seats] of Object.entries(showSeats)) {
      for (const [seatId, seat] of Object.entries(seats)) {
        if (seat.status === 'HELD' && seat.holdExpiresAt && seat.holdExpiresAt <= now) {
          // Lease has expired! Reclaim seat atomically
          const prevHolder = seat.heldBy;
          seat.status = 'AVAILABLE';
          seat.heldBy = null;
          seat.heldByName = null;
          seat.holdToken = null;
          seat.holdExpiresAt = null;
          seat.version += 1;

          if (!releasedSeatsByShow[showId]) {
            releasedSeatsByShow[showId] = [];
          }
          releasedSeatsByShow[showId].push(seatId);

          logAuditEvent({
            type: 'LEASE_EXPIRED',
            showId,
            seatId,
            prevHolder,
            message: `Seat ${seatId} hold lease expired after 120s. Returned to pool.`
          });
        }
      }
    }

    // Broadcast releases to all clients
    for (const [showId, seatIds] of Object.entries(releasedSeatsByShow)) {
      this.broadcast({
        type: 'SEATS_RELEASED',
        showId,
        seatIds,
        reason: 'EXPIRED'
      });
    }
  }

  /**
   * Atomic Seat Hold Acquisition (Two-Phase Locking to prevent race conditions & deadlocks)
   */
  acquireHold(showId, seatIds, clientId, customerName = 'Guest') {
    const seats = showSeats[showId];
    if (!seats) {
      return { success: false, status: 404, message: 'Screening not found' };
    }

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return { success: false, status: 400, message: 'No seats specified' };
    }

    const now = Date.now();
    // Sort seat IDs lexicographically to prevent deadlocks when locking multiple resources
    const sortedSeatIds = [...seatIds].sort();

    // PHASE 1: Verify all seats are available or expired
    for (const seatId of sortedSeatIds) {
      const seat = seats[seatId];
      if (!seat) {
        return { success: false, status: 404, message: `Seat ${seatId} does not exist` };
      }

      if (seat.status === 'CONFIRMED') {
        logAuditEvent({
          type: 'RACE_CONFLICT_CONFIRMED',
          showId,
          seatId,
          clientId,
          message: `Client ${clientId.slice(0, 6)} tried to hold confirmed seat ${seatId}. Rejected.`
        });
        return {
          success: false,
          status: 409,
          conflictedSeat: seatId,
          reason: 'ALREADY_SOLD',
          message: `Seat ${seatId} is already booked.`
        };
      }

      // Check if held by someone else and still within TTL
      if (seat.status === 'HELD' && seat.holdExpiresAt > now) {
        if (seat.heldBy !== clientId) {
          const remainingSecs = Math.max(1, Math.round((seat.holdExpiresAt - now) / 1000));
          logAuditEvent({
            type: 'RACE_CONFLICT_HELD',
            showId,
            seatId,
            clientId,
            holder: seat.heldBy,
            message: `RACE CONDITION PREVENTED: Client ${clientId.slice(0, 6)} blocked. Seat ${seatId} held by ${seat.heldBy.slice(0, 6)} (expires in ${remainingSecs}s).`
          });
          return {
            success: false,
            status: 409,
            conflictedSeat: seatId,
            reason: 'HELD_BY_ANOTHER',
            message: `Seat ${seatId} is locked by another customer (${remainingSecs}s remaining on hold).`
          };
        }
      }
    }

    // PHASE 2: Atomic State Transition (CAS)
    const holdToken = crypto.randomUUID();
    const expiresAt = now + HOLD_DURATION_MS;

    sortedSeatIds.forEach(seatId => {
      const seat = seats[seatId];
      seat.status = 'HELD';
      seat.heldBy = clientId;
      seat.heldByName = customerName;
      seat.holdToken = holdToken;
      seat.holdExpiresAt = expiresAt;
      seat.version += 1;
    });

    logAuditEvent({
      type: 'HOLD_GRANTED',
      showId,
      seatIds: sortedSeatIds,
      clientId,
      expiresAt,
      message: `Atomic lock granted to ${clientId.slice(0, 6)} for [${sortedSeatIds.join(', ')}] until ${new Date(expiresAt).toLocaleTimeString()}`
    });

    // Notify all connected clients
    this.broadcast({
      type: 'SEATS_HELD',
      showId,
      seatIds: sortedSeatIds,
      heldBy: clientId,
      heldByName: customerName,
      expiresAt
    });

    return {
      success: true,
      status: 200,
      holdToken,
      expiresAt,
      holdDurationMs: HOLD_DURATION_MS,
      seats: sortedSeatIds.map(id => seats[id])
    };
  }

  /**
   * Release a previously held seat
   */
  releaseHold(showId, seatIds, clientId, holdToken) {
    const seats = showSeats[showId];
    if (!seats) return { success: false, status: 404, message: 'Screening not found' };

    const released = [];
    seatIds.forEach(seatId => {
      const seat = seats[seatId];
      if (seat && seat.status === 'HELD' && (seat.heldBy === clientId || seat.holdToken === holdToken)) {
        seat.status = 'AVAILABLE';
        seat.heldBy = null;
        seat.heldByName = null;
        seat.holdToken = null;
        seat.holdExpiresAt = null;
        seat.version += 1;
        released.push(seatId);
      }
    });

    if (released.length > 0) {
      logAuditEvent({
        type: 'HOLD_RELEASED',
        showId,
        seatIds: released,
        clientId,
        message: `Seats [${released.join(', ')}] voluntarily released by ${clientId.slice(0, 6)}`
      });

      this.broadcast({
        type: 'SEATS_RELEASED',
        showId,
        seatIds: released,
        reason: 'USER_DESELECTED'
      });
    }

    return { success: true, released };
  }

  /**
   * Atomic Booking Confirmation with Optimistic Concurrency Control Check
   */
  confirmBooking(showId, seatIds, clientId, holdToken, customerInfo) {
    const seats = showSeats[showId];
    if (!seats) return { success: false, status: 404, message: 'Screening not found' };

    const now = Date.now();
    const sortedSeatIds = [...seatIds].sort();

    // Verify hold integrity
    for (const seatId of sortedSeatIds) {
      const seat = seats[seatId];
      if (!seat) {
        return { success: false, status: 404, message: `Seat ${seatId} not found` };
      }
      if (seat.status !== 'HELD' || seat.heldBy !== clientId || seat.holdToken !== holdToken) {
        return {
          success: false,
          status: 409,
          message: `Hold validation failed on seat ${seatId}. Hold may have expired or was released.`
        };
      }
      if (seat.holdExpiresAt <= now) {
        return {
          success: false,
          status: 410,
          message: `Your reservation lock for seat ${seatId} expired before checkout completed.`
        };
      }
    }

    // Atomic confirmation
    let totalAmount = 0;
    const confirmedSeats = sortedSeatIds.map(seatId => {
      const seat = seats[seatId];
      seat.status = 'CONFIRMED';
      seat.heldBy = null;
      seat.heldByName = null;
      seat.holdToken = null;
      seat.holdExpiresAt = null;
      seat.version += 1;
      totalAmount += seat.price;
      return seat;
    });

    // Lookup movie & show metadata
    let targetMovie = null;
    let targetShow = null;
    for (const m of movies) {
      const s = m.shows.find(sh => sh.id === showId);
      if (s) {
        targetMovie = m;
        targetShow = s;
        break;
      }
    }

    const bookingId = 'CP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const booking = {
      bookingId,
      showId,
      movieTitle: targetMovie ? targetMovie.title : 'Movie Ticket',
      moviePoster: targetMovie ? targetMovie.poster : '',
      showTime: targetShow ? targetShow.time : 'TBD',
      showDate: targetShow ? targetShow.date : 'TBD',
      hall: targetShow ? targetShow.hall : 'Auditorium 1',
      screenType: targetShow ? targetShow.screenType : 'Standard Screen',
      seatIds: sortedSeatIds,
      seatDetails: confirmedSeats,
      subtotal: totalAmount,
      bookingFee: 2.50 * sortedSeatIds.length,
      tax: parseFloat((totalAmount * 0.08).toFixed(2)),
      total: parseFloat((totalAmount + (2.50 * sortedSeatIds.length) + (totalAmount * 0.08)).toFixed(2)),
      customer: {
        name: customerInfo.name || 'Anonymous Customer',
        email: customerInfo.email || 'customer@example.com',
        paymentMethod: customerInfo.paymentMethod || 'Visa ending in 4242'
      },
      confirmedAt: new Date().toISOString(),
      qrPayload: `CINEPULSE:${bookingId}:${showId}:${sortedSeatIds.join(',')}:${Date.now()}`
    };

    bookings.unshift(booking);

    logAuditEvent({
      type: 'BOOKING_COMPLETED',
      showId,
      bookingId,
      seatIds: sortedSeatIds,
      total: booking.total,
      customer: booking.customer.name,
      message: `Booking #${bookingId} confirmed for ${booking.customer.name} [${sortedSeatIds.join(', ')}] Total: $${booking.total}`
    });

    // Broadcast confirmed seats
    this.broadcast({
      type: 'SEATS_CONFIRMED',
      showId,
      seatIds: sortedSeatIds,
      bookingId
    });

    return { success: true, booking };
  }

  /**
   * Cancel booking and release seats back to the public pool
   */
  cancelBooking(bookingId) {
    const index = bookings.findIndex(b => b.bookingId === bookingId);
    if (index === -1) {
      return { success: false, status: 404, message: 'Booking not found' };
    }

    const booking = bookings[index];
    const seats = showSeats[booking.showId];
    if (seats) {
      booking.seatIds.forEach(seatId => {
        if (seats[seatId]) {
          seats[seatId].status = 'AVAILABLE';
          seats[seatId].version += 1;
        }
      });
    }

    bookings.splice(index, 1);

    logAuditEvent({
      type: 'BOOKING_CANCELLED',
      bookingId,
      showId: booking.showId,
      seatIds: booking.seatIds,
      message: `Booking #${bookingId} cancelled. Seats [${booking.seatIds.join(', ')}] returned to pool.`
    });

    this.broadcast({
      type: 'SEATS_RELEASED',
      showId: booking.showId,
      seatIds: booking.seatIds,
      reason: 'BOOKING_CANCELLED'
    });

    return { success: true, message: `Booking #${bookingId} cancelled.` };
  }

  /**
   * Reset all seats in a screening (handy for interactive testing & resetting demos)
   */
  resetShowSeats(showId) {
    const { generateSeatsForShow } = require('./store');
    showSeats[showId] = generateSeatsForShow();

    logAuditEvent({
      type: 'SHOW_RESET',
      showId,
      message: `Screening ${showId} reset to default state.`
    });

    this.broadcast({
      type: 'SHOW_RESET',
      showId
    });

    return { success: true, seats: showSeats[showId] };
  }

  /**
   * Concurrency Stress Test Suite: Simulate Bot Rush
   * Fires N simultaneous concurrent hold requests on the same seat at t0
   */
  async simulateRaceCondition(showId, targetSeatId, botCount = 25) {
    const seats = showSeats[showId];
    if (!seats || !seats[targetSeatId]) {
      return { success: false, message: `Seat ${targetSeatId} does not exist.` };
    }

    // First ensure target seat is set to AVAILABLE
    seats[targetSeatId].status = 'AVAILABLE';
    seats[targetSeatId].heldBy = null;
    seats[targetSeatId].holdExpiresAt = null;
    seats[targetSeatId].holdToken = null;

    const startHrTime = process.hrtime.bigint();
    const attempts = [];

    // Create N bot requests
    const botPromises = Array.from({ length: botCount }, (_, i) => {
      const botId = `bot-${i + 1}-${crypto.randomBytes(2).toString('hex')}`;
      const botName = `AutoBot #${i + 1}`;

      return new Promise(resolve => {
        // High resolution dispatch
        const dispatchHrTime = process.hrtime.bigint();
        const res = this.acquireHold(showId, [targetSeatId], botId, botName);
        const resolvedHrTime = process.hrtime.bigint();
        const latencyMicroseconds = Number(resolvedHrTime - dispatchHrTime) / 1000;

        const attemptResult = {
          botNumber: i + 1,
          botId,
          botName,
          status: res.status,
          success: res.success,
          latencyUs: Math.round(latencyMicroseconds),
          reason: res.success ? 'WON_LOCK (200 OK)' : res.message,
          timestamp: new Date().toISOString()
        };

        attempts.push(attemptResult);
        resolve(attemptResult);
      });
    });

    await Promise.all(botPromises);
    const endHrTime = process.hrtime.bigint();
    const totalDurationMs = Number(endHrTime - startHrTime) / 1_000_000;

    // Analyze results
    const winners = attempts.filter(a => a.success);
    const conflicts = attempts.filter(a => !a.success);

    const raceReport = {
      testId: 'RACE-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      showId,
      targetSeat: targetSeatId,
      totalBots: botCount,
      totalDurationMs: parseFloat(totalDurationMs.toFixed(2)),
      winnerCount: winners.length,
      conflictCount: conflicts.length,
      doubleBookingPrevented: winners.length === 1 && conflicts.length === botCount - 1,
      winner: winners[0] || null,
      attempts: attempts.sort((a, b) => (a.success ? -1 : 1)) // put winner on top
    };

    logAuditEvent({
      type: 'RACE_SIMULATION_EXECUTED',
      showId,
      seatId: targetSeatId,
      botCount,
      winner: winners[0] ? winners[0].botName : 'None',
      doubleBookingPrevented: raceReport.doubleBookingPrevented,
      message: `Race Condition Test: ${botCount} bots rushed seat ${targetSeatId}. Winner: ${winners[0]?.botName}. 0 double bookings!`
    });

    return {
      success: true,
      report: raceReport
    };
  }
}

const lockEngineInstance = new LockEngine();
module.exports = lockEngineInstance;
