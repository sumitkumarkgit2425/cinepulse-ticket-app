// server/index.js
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const { movies, showSeats, bookings, auditLogs, logAuditEvent } = require('./store');
const lockEngine = require('./lockEngine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

// Load environment variables from .env
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // .env already loaded or not found
}

const Razorpay = require('razorpay');

function getRazorpayInstance() {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile();
    }
  } catch (e) {}

  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();

  if (keyId && keySecret && !keyId.includes('YOUR_RAZORPAY') && !keySecret.includes('YOUR_RAZORPAY')) {
    return {
      client: new Razorpay({ key_id: keyId, key_secret: keySecret }),
      keyId
    };
  }
  return { client: null, keyId: null };
}

app.post('/api/payment/order', async (req, res) => {
  try {
    const { amount } = req.body;
    const finalKeyId = keyId || process.env.RAZORPAY_KEY_ID || '';

    // If Razorpay backend client is initialized with secret, create server order
    if (client) {
      try {
        const options = {
          amount: Math.round(Number(amount) * 100), // In paise (₹1 = 100 paise)
          currency: "INR",
          receipt: "receipt_order_" + Date.now().toString().slice(-8)
        };
        const order = await client.orders.create(options);
        console.log(`✅ Razorpay Order Created: ${order.id} for ₹${amount}`);
        return res.json({ success: true, order, keyId: finalKeyId });
      } catch (orderErr) {
        console.warn("⚠️ Razorpay order.create failed, falling back to standard checkout:", orderErr.message);
      }
    }

    // Standard client-side Razorpay checkout mode (works with just public Key ID!)
    console.log(`ℹ️ Launching Razorpay Standard Checkout for key: ${finalKeyId}`);
    return res.json({
      success: true,
      clientOnly: true,
      keyId: finalKeyId,
      amount: Math.round(Number(amount) * 100)
    });
  } catch (error) {
    console.error("❌ Payment endpoint error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Create HTTP server & attach WebSocketServer
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Map of active connected clients: clientId -> ws
const connectedClients = new Map();

// Helper to broadcast WS payload to all clients
function broadcastToAll(payload) {
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// Hook lock engine broadcast to WebSocket
lockEngine.setBroadcaster((msg) => {
  broadcastToAll(msg);
});

// WebSocket Connection Lifecycle
wss.on('connection', (ws) => {
  const clientId = 'client_' + crypto.randomUUID().slice(0, 8);
  connectedClients.set(clientId, ws);

  // Send greeting with assigned client ID and current online user count
  ws.send(JSON.stringify({
    type: 'INIT_SESSION',
    clientId,
    onlineCount: wss.clients.size
  }));

  // Broadcast updated count to all
  broadcastToAll({
    type: 'PRESENCE_UPDATE',
    onlineCount: wss.clients.size
  });

  logAuditEvent({
    type: 'CLIENT_CONNECTED',
    clientId,
    message: `Client ${clientId} connected via WebSocket. Online count: ${wss.clients.size}`
  });

  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch (e) {
      // Ignore invalid JSON
    }
  });

  ws.on('close', () => {
    connectedClients.delete(clientId);
    broadcastToAll({
      type: 'PRESENCE_UPDATE',
      onlineCount: wss.clients.size
    });
    logAuditEvent({
      type: 'CLIENT_DISCONNECTED',
      clientId,
      message: `Client ${clientId} disconnected. Online count: ${wss.clients.size}`
    });
  });
});

// --- REST API ENDPOINTS ---

// 0. Public Client Config
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    tmdbApiKey: process.env.TMDB_API_KEY || '',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || ''
  });
});

// 1. Get all movies and screenings
app.get('/api/shows', (req, res) => {
  res.json({ success: true, movies });
});

// 2. Get specific show details with current seat matrix
app.get('/api/shows/:id/seats', (req, res) => {
  const showId = req.params.id;
  const seats = showSeats[showId];
  if (!seats) {
    return res.status(404).json({ success: false, message: 'Screening not found' });
  }

  // Calculate stats
  let totalAvailable = 0;
  let totalHeld = 0;
  let totalConfirmed = 0;
  const now = Date.now();

  Object.values(seats).forEach(seat => {
    if (seat.status === 'CONFIRMED') totalConfirmed++;
    else if (seat.status === 'HELD' && seat.holdExpiresAt > now) totalHeld++;
    else totalAvailable++;
  });

  res.json({
    success: true,
    showId,
    stats: {
      total: Object.keys(seats).length,
      available: totalAvailable,
      held: totalHeld,
      confirmed: totalConfirmed
    },
    seats
  });
});

// 3. Atomic Seat Hold Request (Protects against Race Conditions)
app.post('/api/seats/hold', (req, res) => {
  const { showId, seatIds, clientId, customerName } = req.body;
  if (!showId || !seatIds || !clientId) {
    return res.status(400).json({ success: false, message: 'Missing required parameters' });
  }

  const result = lockEngine.acquireHold(showId, seatIds, clientId, customerName);
  res.status(result.status || 200).json(result);
});

// 4. Release Held Seats (User deselected or cancelled)
app.post('/api/seats/release', (req, res) => {
  const { showId, seatIds, clientId, holdToken } = req.body;
  if (!showId || !seatIds || !clientId) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }

  const result = lockEngine.releaseHold(showId, seatIds, clientId, holdToken);
  res.json(result);
});

// 5. Atomic Checkout & Confirm Booking
app.post('/api/seats/book', (req, res) => {
  const { showId, seatIds, clientId, holdToken, customerInfo } = req.body;
  if (!showId || !seatIds || !clientId || !holdToken || !customerInfo) {
    return res.status(400).json({ success: false, message: 'Incomplete booking data' });
  }

  const result = lockEngine.confirmBooking(showId, seatIds, clientId, holdToken, customerInfo);
  res.status(result.status || 200).json(result);
});

// 6. Concurrency Stress Test Suite: Simulate Bot Rush
app.post('/api/simulate-race', async (req, res) => {
  const { showId, seatId, botCount } = req.body;
  if (!showId || !seatId) {
    return res.status(400).json({ success: false, message: 'Provide showId and seatId' });
  }

  const count = Math.min(Math.max(parseInt(botCount, 10) || 20, 2), 50);
  const result = await lockEngine.simulateRaceCondition(showId, seatId, count);
  res.json(result);
});

// 7. Get All Confirmed Bookings (for "My Tickets" tab)
app.get('/api/bookings', (req, res) => {
  res.json({ success: true, bookings });
});

// 8. Cancel a Booking and return seats to pool
app.delete('/api/bookings/:id', (req, res) => {
  const bookingId = req.params.id;
  const result = lockEngine.cancelBooking(bookingId);
  res.status(result.status || 200).json(result);
});

// 9. Get Live Concurrency Audit Logs
app.get('/api/audit-logs', (req, res) => {
  res.json({ success: true, logs: auditLogs });
});

// 10. Reset Screening Seats (Testing utility)
app.post('/api/shows/:id/reset', (req, res) => {
  const showId = req.params.id;
  const result = lockEngine.resetShowSeats(showId);
  res.json(result);
});

// Start Server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🎬 CinePulse Server running with Race-Condition-Elimination on http://localhost:${PORT}`);
  });
}

module.exports = app;
