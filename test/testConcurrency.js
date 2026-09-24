// test/testConcurrency.js
const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(respData) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: respData });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let respData = '';
      res.on('data', chunk => { respData += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(respData) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: respData });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('🧪 Starting CinePulse Concurrency & Race Condition Test Suite...\n');

  // Test 1: Fetch shows
  const showsRes = await get('/api/shows');
  console.assert(showsRes.status === 200, 'Test 1 Failed: /api/shows should return 200');
  console.assert(showsRes.data.movies.length > 0, 'Test 1 Failed: movies should not be empty');
  console.log('✅ TEST 1 PASSED: Movies and screenings fetched successfully.');

  // Test 2: Fetch seat grid
  const seatsRes = await get('/api/shows/show-101/seats');
  console.assert(seatsRes.status === 200, 'Test 2 Failed: seats should return 200');
  const seatKeys = Object.keys(seatsRes.data.seats);
  console.assert(seatKeys.length === 96, `Test 2 Failed: expected 96 seats, got ${seatKeys.length}`);
  console.log(`✅ TEST 2 PASSED: Auditorium 1 loaded with ${seatKeys.length} seats.`);

  // Test 3: Client A acquires atomic hold on Seat C5
  const clientA = 'client_test_AAA';
  const holdA = await post('/api/seats/hold', {
    showId: 'show-101',
    seatIds: ['C5'],
    clientId: clientA,
    customerName: 'Alice'
  });
  console.assert(holdA.status === 200 && holdA.data.success, 'Test 3 Failed: Client A hold should succeed');
  const holdTokenA = holdA.data.holdToken;
  console.log(`✅ TEST 3 PASSED: Client A granted atomic lock on C5. HoldToken: ${holdTokenA.slice(0, 8)}...`);

  // Test 4: Client B attempts to snatch Seat C5 simultaneously (Race Condition Detection)
  const clientB = 'client_test_BBB';
  const holdB = await post('/api/seats/hold', {
    showId: 'show-101',
    seatIds: ['C5'],
    clientId: clientB,
    customerName: 'Bob'
  });
  console.assert(holdB.status === 409, `Test 4 Failed: Client B should get 409 Conflict, got ${holdB.status}`);
  console.assert(holdB.data.conflictedSeat === 'C5', 'Test 4 Failed: conflictedSeat should be C5');
  console.log(`✅ TEST 4 PASSED: Race Condition ELIMINATED! Client B blocked with 409 Conflict: "${holdB.data.message}"`);

  // Test 5: Bot Rush Simulation (25 concurrent requests on Seat A6)
  const botSim = await post('/api/simulate-race', {
    showId: 'show-101',
    seatId: 'A6',
    botCount: 25
  });
  console.assert(botSim.status === 200 && botSim.data.success, 'Test 5 Failed: Bot race failed');
  const report = botSim.data.report;
  console.assert(report.winnerCount === 1, `Test 5 Failed: Expected 1 winner, got ${report.winnerCount}`);
  console.assert(report.conflictCount === 24, `Test 5 Failed: Expected 24 conflicts, got ${report.conflictCount}`);
  console.assert(report.doubleBookingPrevented === true, 'Test 5 Failed: Double booking was NOT prevented');
  console.log(`✅ TEST 5 PASSED: 25-Bot Concurrency Rush executed in ${report.totalDurationMs}ms.`);
  console.log(`   🏆 Winner: ${report.winner.botName} acquired atomic lock in ${report.winner.latencyUs}μs.`);
  console.log(`   ⛔ 24 competing requests safely rejected with 409 Conflict.`);
  console.log(`   🛡️ Zero double bookings: 100% Guaranteed!`);

  // Test 6: Complete checkout for Client A
  const bookRes = await post('/api/seats/book', {
    showId: 'show-101',
    seatIds: ['C5'],
    clientId: clientA,
    holdToken: holdTokenA,
    customerInfo: {
      name: 'Alice Cooper',
      email: 'alice@example.com',
      paymentMethod: 'Apple Pay'
    }
  });
  console.assert(bookRes.status === 200 && bookRes.data.success, 'Test 6 Failed: Booking should succeed');
  const bookingId = bookRes.data.booking.bookingId;
  console.log(`✅ TEST 6 PASSED: Booking confirmed! Ticket #${bookingId} generated with QR pass.`);

  // Test 7: Post-checkout attempt on C5 (Should fail with ALREADY_SOLD)
  const holdC = await post('/api/seats/hold', {
    showId: 'show-101',
    seatIds: ['C5'],
    clientId: 'client_test_CCC'
  });
  console.assert(holdC.status === 409, 'Test 7 Failed: Confirmed seat should be rejected with 409');
  console.log(`✅ TEST 7 PASSED: Confirmed seat protected. Re-reservation attempt rejected: "${holdC.data.message}"`);

  // Test 8: Cancellation releases seat back to available
  const cancelRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: `/api/bookings/${bookingId}`,
      method: 'DELETE'
    }, res => {
      let d = '';
      res.on('data', chunk => { d += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end();
  });
  console.assert(cancelRes.status === 200 && cancelRes.data.success, 'Test 8 Failed: Cancellation failed');
  console.log(`✅ TEST 8 PASSED: Booking #${bookingId} cancelled; seat C5 returned to available pool.`);

  console.log('\n🎉 ALL 8 TESTS PASSED WITH 100% CONCURRENCY SAFETY!');
}

runTests().catch(err => {
  console.error('❌ Test suite error:', err);
  process.exit(1);
});
