# 🎬 CinePulse — Real-Time Cinema Ticketing & Atomic Seat Reservation Engine

[![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-5.x-000000?style=flat&logo=express&logoColor=white)](https://expressjs.com/)
[![WebSockets](https://img.shields.io/badge/WebSockets-Real--Time-010101?style=flat&logo=socketdotio&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore-FFCA28?style=flat&logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Razorpay](https://img.shields.io/badge/Razorpay-Payment_Gateway-02042B?style=flat&logo=razorpay&logoColor=3395FF)](https://razorpay.com/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

> **CinePulse** is a high-concurrency movie ticketing and seat reservation application designed to eliminate race conditions, double-bookings, and cart collisions during flash-sale ticket rushes. Featuring atomic seat holds, real-time WebSocket synchronization, Indian Rupee (₹) pricing, Razorpay checkout, and verified digital cinema boarding passes.

---

## 🌟 Key Features

- **⚡ Atomic Concurrency Engine**: In-memory seat locking with automatic 10-minute countdown expiration to guarantee that no two users can book the same seat simultaneously.
- **🔄 Real-Time Cross-Client Sync**: WebSocket and Firebase Firestore listeners instantly reflect seat states (`Available`, `Selected`, `Held by Others`, `Sold Out`) across all connected devices.
- **🎟️ Interactive Cinema Hall Grid**: Tiered seating layout with **VIP Recliners (₹450)**, **Premium Club (₹320)**, and **Standard Experience (₹220)**.
- **💳 Multi-Mode Payment Integration**:
  - **Razorpay Online Gateway**: Full support for UPI (Google Pay, PhonePe, Paytm), Credit/Debit Cards, and NetBanking with automated order generation.
  - **Instant Pass (Test Mode)**: One-click bypass for instant offline/developer testing without payment gateway overhead.
- **🎫 Digital Cinema Boarding Pass**: Generates a verified ticket pass with dynamic canvas QR codes, barcodes, seat details, and print/PDF support.
- **🎬 Movie Discovery**: Dynamic showtime selector, synopsis, trailers, and optional The Movie Database (TMDB) API integration.
- **💎 Premium Glassmorphic UI**: Ultra-sleek dark aesthetic with micro-interactions, audio chimes, and responsive design for desktop and mobile.

---

## 🏗️ Architecture & Tech Stack

```
cinepulse-ticket-app/
├── server/
│   ├── index.js          # Express HTTP API & WebSocket server
│   ├── lockEngine.js     # Atomic hold & race condition mitigation logic
│   └── store.js          # In-memory mock data, screenings & audit logger
├── ui/
│   ├── index.html        # Single-page cinema application
│   ├── css/
│   │   └── style.css     # Premium dark-mode glassmorphic design system
│   └── js/
│       ├── app.js        # UI controller, seat interactions & checkout
│       └── services/
│           ├── firebaseAuth.js  # Optional Firebase authentication
│           ├── firestoreDb.js   # Firestore seat transactions & sync
│           └── tmdb.js          # TMDB movie catalog service
├── .env.example          # Environment variable template
├── package.json          # Project metadata and dependencies
└── README.md             # Documentation
```

- **Backend**: Node.js, Express 5, WebSocket (`ws`), Razorpay SDK
- **Frontend**: Vanilla JavaScript (ES Modules), HTML5 Canvas QR Generator, Modern CSS3
- **Database / Cloud**: Firebase Firestore (multi-client synchronization)

---

## 🚀 Getting Started

### Prerequisites

Ensure you have [Node.js](https://nodejs.org/) (v18 or higher) installed on your system.

```bash
node -v
npm -v
```

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/cinepulse-ticket-app.git
   cd cinepulse-ticket-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

   Open `.env` and fill in your credentials:
   ```env
   # Server Port
   PORT=3000

   # Razorpay API Keys (Test Mode)
   RAZORPAY_KEY_ID=your_razorpay_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_key_secret

   # TMDB API (Optional - falls back to local movies if omitted)
   TMDB_API_KEY=your_tmdb_api_key

   # Firebase Configuration (Optional)
   FIREBASE_API_KEY=your_firebase_api_key
   FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   FIREBASE_PROJECT_ID=your_project_id
   FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
   FIREBASE_MESSAGING_SENDER_ID=your_sender_id
   FIREBASE_APP_ID=your_app_id
   ```

4. Launch the application:
   ```bash
   npm start
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## 🔒 Security & Best Practices

- **Never commit `.env`**: Environment files containing API keys and secrets are explicitly ignored by `.gitignore`.
- **Public vs. Private Keys**: `RAZORPAY_KEY_SECRET` stays strictly on the server to sign and create orders. The client only receives temporary order tokens.
- **Fail-Safe Fallbacks**: If external APIs (TMDB, Razorpay) are not configured, the app gracefully switches to curated local cinema data and Instant Pass testing.

---

## 📝 License

This project is licensed under the [ISC License](LICENSE).
