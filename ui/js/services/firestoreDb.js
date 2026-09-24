import { getFirestore, collection, doc, runTransaction, onSnapshot, writeBatch, getDocs } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { app } from './firebaseAuth.js';

const db = getFirestore(app);
let unsubscribeSeats = null;

export async function initShowSeats(showId) {
  const seatsRef = collection(db, 'shows', showId, 'seats');
  const snap = await getDocs(seatsRef);
  if (!snap.empty) return;
  const batch = writeBatch(db);
  const rows = ['A','B','C','D','E','F','G','H'];
  rows.forEach(r => {
    for(let i=1; i<=12; i++) {
      let tier = 'standard';
      let price = 14.00;
      let label = 'Standard Experience';
      if(r==='A'||r==='B'){ tier='vip'; price=24.50; label='VIP Recliners'; }
      else if(r==='C'||r==='D'||r==='E'){ tier='premium'; price=18.50; label='Premium Club'; }
      const seatId = `${r}${i}`;
      batch.set(doc(seatsRef, seatId), {
        status: 'AVAILABLE',
        heldBy: null,
        holdExpiresAt: 0,
        number: i,
        price,
        tier,
        tierLabel: label
      });
    }
  });
  await batch.commit();
}

export function listenToSeats(showId, callback) {
  if (unsubscribeSeats) unsubscribeSeats();
  const seatsRef = collection(db, 'shows', showId, 'seats');
  unsubscribeSeats = onSnapshot(seatsRef, (snapshot) => {
    const seatsData = {};
    snapshot.forEach(doc => {
      seatsData[doc.id] = doc.data();
    });
    callback(seatsData);
  });
}

export async function holdSeat(showId, seatId, clientId) {
  const seatRef = doc(db, 'shows', showId, 'seats', seatId);
  try {
    const result = await runTransaction(db, async (t) => {
      const docSnap = await t.get(seatRef);
      if (!docSnap.exists()) throw "Seat missing";
      const data = docSnap.data();
      const now = Date.now();
      if (data.status === 'CONFIRMED') throw "Already booked";
      if (data.status === 'HELD' && data.heldBy !== clientId && data.holdExpiresAt > now) throw "Locked by another user";
      const expiresAt = now + 120000;
      t.update(seatRef, { status: 'HELD', heldBy: clientId, holdExpiresAt: expiresAt });
      return { expiresAt, price: data.price, tierLabel: data.tierLabel };
    });
    return { success: true, expiresAt: result.expiresAt, price: result.price, tierLabel: result.tierLabel };
  } catch (e) {
    return { success: false, message: typeof e === 'string' ? e : "Error holding seat" };
  }
}

export async function releaseSeat(showId, seatId, clientId) {
  const seatRef = doc(db, 'shows', showId, 'seats', seatId);
  try {
    await runTransaction(db, async (t) => {
      const docSnap = await t.get(seatRef);
      if (!docSnap.exists()) return;
      const data = docSnap.data();
      if (data.status === 'HELD' && data.heldBy === clientId) {
        t.update(seatRef, { status: 'AVAILABLE', heldBy: null, holdExpiresAt: 0 });
      }
    });
  } catch (e) {}
}

export async function bookSeats(showId, seatIds, clientId, customerInfo) {
  try {
    await runTransaction(db, async (t) => {
      const docs = [];
      for (const id of seatIds) {
        const ref = doc(db, 'shows', showId, 'seats', id);
        docs.push({ ref, snap: await t.get(ref) });
      }
      for (const { ref, snap } of docs) {
        if (!snap.exists()) throw "Seat missing";
        const data = snap.data();
        if (data.status === 'CONFIRMED') throw "Already booked";
        if (data.heldBy !== clientId) throw "Lock expired";
        t.update(ref, { status: 'CONFIRMED', heldBy: clientId, bookedBy: customerInfo.name, bookedAt: Date.now() });
      }
    });
    return { success: true, bookingId: 'BK' + Date.now().toString().slice(-6) };
  } catch (e) {
    return { success: false, message: typeof e === 'string' ? e : "Booking failed" };
  }
}
