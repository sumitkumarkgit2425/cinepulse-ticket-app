// server/store.js
const crypto = require('crypto');

// Generate realistic theater seating (8 rows: A-H, 12 seats per row = 96 seats per show)
function generateSeatsForShow() {
  const seats = {};
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  
  rows.forEach((row, rowIndex) => {
    let tier = 'standard';
    let price = 14.00;
    let label = 'Standard';

    if (rowIndex < 2) { // Rows A, B: VIP Recliners
      tier = 'vip';
      price = 24.50;
      label = 'VIP Recliner';
    } else if (rowIndex < 5) { // Rows C, D, E: Premium Club
      tier = 'premium';
      price = 18.50;
      label = 'Premium Club';
    }

    for (let num = 1; num <= 12; num++) {
      const seatId = `${row}${num}`;
      // Pre-seed a few booked seats for realistic demo feel
      const isPreBooked = (row === 'D' && (num === 6 || num === 7)) || (row === 'F' && num === 3);

      seats[seatId] = {
        id: seatId,
        row,
        number: num,
        tier,
        tierLabel: label,
        price,
        status: isPreBooked ? 'CONFIRMED' : 'AVAILABLE', // AVAILABLE | HELD | CONFIRMED
        heldBy: null,       // clientId
        heldByName: null,   // Customer display name
        holdToken: null,    // UUID for atomic checkout verification
        holdExpiresAt: null,// timestamp in ms
        version: 1          // Optimistic Concurrency Control version counter
      };
    }
  });

  return seats;
}

// Rich Movie Catalog with Theaters & Showtimes (BookMyShow-Style)
const movies = [
  {
    id: 'movie-1',
    title: 'Dune: Part Two',
    tagline: 'Long live the fighters.',
    genre: 'Sci-Fi / Adventure / Action',
    category: 'Sci-Fi',
    duration: '166 min',
    rating: 'UA 16+',
    score: '9.3',
    votes: '248.5K Votes',
    languages: ['English', 'IMAX 2D', 'Hindi', 'Dolby Atmos'],
    releaseDate: 'In Cinemas Now',
    director: 'Denis Villeneuve',
    cast: 'Timothée Chalamet, Zendaya, Rebecca Ferguson, Javier Bardem',
    banner: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=600&auto=format&fit=crop&q=80',
    synopsis: 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family, facing a choice between the love of his life and the fate of the universe.',
    cinemas: [
      {
        cinemaId: 'cin-1',
        name: 'PVR INOX IMAX & Laser — Metropolis Mall',
        distance: '1.2 km away',
        amenities: ['M-Ticket', 'Food & Beverage', 'Recliner Seats', 'Wheelchair Accessible'],
        shows: [
          { id: 'show-101', time: '11:00 AM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'available', priceStarting: 14.00, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-102', time: '02:30 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'fast-filling', priceStarting: 18.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-103', time: '06:15 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'almost-full', priceStarting: 24.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-104', time: '09:45 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'available', priceStarting: 18.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' }
        ]
      },
      {
        cinemaId: 'cin-2',
        name: 'CinePulse Dolby Cinema — Downtown Promenade',
        distance: '3.4 km away',
        amenities: ['M-Ticket', 'Dolby Atmos', 'Dolby Vision', 'Premium Dining'],
        shows: [
          { id: 'show-105', time: '01:15 PM', date: 'Today, Sep 24', format: 'DOLBY ATMOS', status: 'available', priceStarting: 16.00, hall: 'Auditorium 4 (Dolby Cinema)', screenType: 'DOLBY ATMOS & VISION' },
          { id: 'show-106', time: '05:00 PM', date: 'Today, Sep 24', format: 'DOLBY ATMOS', status: 'fast-filling', priceStarting: 18.50, hall: 'Auditorium 4 (Dolby Cinema)', screenType: 'DOLBY ATMOS & VISION' },
          { id: 'show-107', time: '08:30 PM', date: 'Today, Sep 24', format: 'DOLBY ATMOS', status: 'almost-full', priceStarting: 22.00, hall: 'Auditorium 4 (Dolby Cinema)', screenType: 'DOLBY ATMOS & VISION' }
        ]
      },
      {
        cinemaId: 'cin-3',
        name: 'StarLight 4DX Multiplex — Riverside Center',
        distance: '5.1 km away',
        amenities: ['M-Ticket', '4DX Motion', 'Free Parking'],
        shows: [
          { id: 'show-108', time: '03:45 PM', date: 'Today, Sep 24', format: '4DX 3D', status: 'available', priceStarting: 15.00, hall: 'Screen 2 (4DX Hall)', screenType: '4DX MOTION & ENVIRONMENTAL FX' },
          { id: 'show-109', time: '07:15 PM', date: 'Today, Sep 24', format: '4DX 3D', status: 'fast-filling', priceStarting: 20.00, hall: 'Screen 2 (4DX Hall)', screenType: '4DX MOTION & ENVIRONMENTAL FX' }
        ]
      }
    ]
  },
  {
    id: 'movie-2',
    title: 'Interstellar: 10th Anniversary',
    tagline: 'Mankind was born on Earth. It was never meant to die here.',
    genre: 'Sci-Fi / Drama / Adventure',
    category: 'Sci-Fi',
    duration: '169 min',
    rating: 'PG-13',
    score: '9.4',
    votes: '382.1K Votes',
    languages: ['English', 'IMAX 70mm', 'Dolby Cinema'],
    releaseDate: 'Special 10th Anniversary Re-Release',
    director: 'Christopher Nolan',
    cast: 'Matthew McConaughey, Anne Hathaway, Jessica Chastain, Michael Caine',
    banner: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=600&auto=format&fit=crop&q=80',
    synopsis: 'When Earth becomes uninhabitable in the future, a farmer and ex-NASA pilot, Joseph Cooper, is tasked to pilot a spacecraft along with a team of researchers through a mysterious wormhole near Saturn.',
    cinemas: [
      {
        cinemaId: 'cin-1',
        name: 'PVR INOX IMAX & Laser — Metropolis Mall',
        distance: '1.2 km away',
        amenities: ['M-Ticket', 'Food & Beverage', 'Recliner Seats'],
        shows: [
          { id: 'show-201', time: '12:30 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'available', priceStarting: 16.00, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-202', time: '04:45 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'almost-full', priceStarting: 24.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-203', time: '08:45 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'fast-filling', priceStarting: 24.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' }
        ]
      },
      {
        cinemaId: 'cin-2',
        name: 'CinePulse Dolby Cinema — Downtown Promenade',
        distance: '3.4 km away',
        amenities: ['M-Ticket', 'Dolby Atmos', 'Dolby Vision', 'Premium Dining'],
        shows: [
          { id: 'show-204', time: '02:00 PM', date: 'Today, Sep 24', format: 'DOLBY ATMOS', status: 'available', priceStarting: 15.00, hall: 'Auditorium 3 (Dolby Cinema)', screenType: 'DOLBY ATMOS & VISION' },
          { id: 'show-205', time: '06:30 PM', date: 'Today, Sep 24', format: 'DOLBY ATMOS', status: 'fast-filling', priceStarting: 20.00, hall: 'Auditorium 3 (Dolby Cinema)', screenType: 'DOLBY ATMOS & VISION' }
        ]
      }
    ]
  },
  {
    id: 'movie-3',
    title: 'Spider-Man: Across the Spider-Verse',
    tagline: 'It is how you wear the mask that matters.',
    genre: 'Animation / Action / Sci-Fi',
    category: 'Animation',
    duration: '140 min',
    rating: 'PG',
    score: '9.2',
    votes: '194.2K Votes',
    languages: ['English', 'IMAX 3D', 'Hindi', 'Spanish'],
    releaseDate: 'In Cinemas Now',
    director: 'Joaquim Dos Santos, Kemp Powers',
    cast: 'Shameik Moore, Hailee Steinfeld, Oscar Isaac, Daniel Kaluuya',
    banner: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80',
    synopsis: 'Miles Morales catapults across the Multiverse, where he encounters a team of Spider-People charged with protecting its very existence. When heroes clash on how to handle a new threat, Miles must redefine heroism.',
    cinemas: [
      {
        cinemaId: 'cin-1',
        name: 'PVR INOX IMAX & Laser — Metropolis Mall',
        distance: '1.2 km away',
        amenities: ['M-Ticket', 'Food & Beverage', 'Recliner Seats'],
        shows: [
          { id: 'show-301', time: '01:00 PM', date: 'Today, Sep 24', format: 'IMAX 3D', status: 'available', priceStarting: 15.00, hall: 'Screen 2 (IMAX 3D)', screenType: 'IMAX 3D LASER' },
          { id: 'show-302', time: '05:30 PM', date: 'Today, Sep 24', format: 'IMAX 3D', status: 'fast-filling', priceStarting: 18.50, hall: 'Screen 2 (IMAX 3D)', screenType: 'IMAX 3D LASER' }
        ]
      },
      {
        cinemaId: 'cin-3',
        name: 'StarLight 4DX Multiplex — Riverside Center',
        distance: '5.1 km away',
        amenities: ['M-Ticket', '4DX Motion', 'Free Parking'],
        shows: [
          { id: 'show-303', time: '03:15 PM', date: 'Today, Sep 24', format: '4DX 3D', status: 'available', priceStarting: 16.50, hall: 'Screen 3 (4DX Hall)', screenType: '4DX MOTION' },
          { id: 'show-304', time: '07:45 PM', date: 'Today, Sep 24', format: '4DX 3D', status: 'almost-full', priceStarting: 22.00, hall: 'Screen 3 (4DX Hall)', screenType: '4DX MOTION' }
        ]
      }
    ]
  },
  {
    id: 'movie-4',
    title: 'Oppenheimer',
    tagline: 'The world forever changes.',
    genre: 'Biography / Drama / History',
    category: 'Drama',
    duration: '180 min',
    rating: 'R',
    score: '9.1',
    votes: '312.4K Votes',
    languages: ['English', 'IMAX 70mm', 'Dolby Atmos'],
    releaseDate: 'Academy Award Winner — Special Screenings',
    director: 'Christopher Nolan',
    cast: 'Cillian Murphy, Emily Blunt, Matt Damon, Robert Downey Jr.',
    banner: 'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?w=600&auto=format&fit=crop&q=80',
    synopsis: 'The story of American scientist J. Robert Oppenheimer and his role in the development of the atomic bomb during World War II, examining the moral weight of technological breakthroughs.',
    cinemas: [
      {
        cinemaId: 'cin-1',
        name: 'PVR INOX IMAX & Laser — Metropolis Mall',
        distance: '1.2 km away',
        amenities: ['M-Ticket', 'Food & Beverage', 'Recliner Seats'],
        shows: [
          { id: 'show-401', time: '02:15 PM', date: 'Today, Sep 24', format: '70MM FILM', status: 'available', priceStarting: 16.00, hall: 'Screen 1 (70mm Grand)', screenType: '70MM FILM PROJECTION' },
          { id: 'show-402', time: '07:00 PM', date: 'Today, Sep 24', format: '70MM FILM', status: 'fast-filling', priceStarting: 24.50, hall: 'Screen 1 (70mm Grand)', screenType: '70MM FILM PROJECTION' }
        ]
      }
    ]
  },
  {
    id: 'movie-5',
    title: 'Cyberpunk: Neon Horizon',
    tagline: 'Where chrome meets destiny.',
    genre: 'Cyberpunk / Action / Thriller',
    category: 'Action',
    duration: '138 min',
    rating: 'R',
    score: '8.9',
    votes: '115.8K Votes',
    languages: ['English', 'Japanese', '4K HDR Laser'],
    releaseDate: 'Exclusive Premier',
    director: 'Elena Kusanagi',
    cast: 'Keanu Reeves, Rinko Kikuchi, Hiroyuki Sanada',
    banner: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80',
    synopsis: 'In a dystopian mega-city ruled by megacorporations, a rogue netrunner discovers a high-stakes conspiracy threatening the global neural net and all humanity.',
    cinemas: [
      {
        cinemaId: 'cin-2',
        name: 'CinePulse Dolby Cinema — Downtown Promenade',
        distance: '3.4 km away',
        amenities: ['M-Ticket', 'Dolby Atmos', 'Dolby Vision', 'Premium Dining'],
        shows: [
          { id: 'show-501', time: '04:00 PM', date: 'Today, Sep 24', format: '4K LASER', status: 'available', priceStarting: 14.00, hall: 'Auditorium 2 (Prime 4K)', screenType: '4K LASER HDR' },
          { id: 'show-502', time: '09:15 PM', date: 'Today, Sep 24', format: '4K LASER', status: 'fast-filling', priceStarting: 18.50, hall: 'Auditorium 2 (Prime 4K)', screenType: '4K LASER HDR' }
        ]
      }
    ]
  },
  {
    id: 'movie-6',
    title: 'The Dark Knight (15th Anniversary)',
    tagline: 'Why so serious?',
    genre: 'Action / Crime / Thriller',
    category: 'Action',
    duration: '152 min',
    rating: 'PG-13',
    score: '9.5',
    votes: '480.9K Votes',
    languages: ['English', 'IMAX 70mm', 'Dolby Atmos'],
    releaseDate: 'Special Limited Screenings',
    director: 'Christopher Nolan',
    cast: 'Christian Bale, Heath Ledger, Aaron Eckhart, Michael Caine',
    banner: 'https://images.unsplash.com/photo-1509281373149-e957c6296406?w=1400&auto=format&fit=crop&q=80',
    poster: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop&q=80',
    synopsis: 'When the menace known as the Joker wreaks havoc and chaos on the people of Gotham, Batman must accept one of the greatest psychological and physical tests of his ability to fight injustice.',
    cinemas: [
      {
        cinemaId: 'cin-1',
        name: 'PVR INOX IMAX & Laser — Metropolis Mall',
        distance: '1.2 km away',
        amenities: ['M-Ticket', 'Food & Beverage', 'Recliner Seats'],
        shows: [
          { id: 'show-601', time: '03:30 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'almost-full', priceStarting: 20.00, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' },
          { id: 'show-602', time: '08:00 PM', date: 'Today, Sep 24', format: 'IMAX 70MM', status: 'almost-full', priceStarting: 24.50, hall: 'Screen 1 (IMAX Laser)', screenType: 'IMAX 70MM DUAL LASER' }
        ]
      }
    ]
  }
];

// Flatten shows list for each movie for quick backwards-compatibility & seat initialization
movies.forEach(movie => {
  movie.shows = [];
  if (movie.cinemas) {
    movie.cinemas.forEach(cinema => {
      cinema.shows.forEach(show => {
        show.cinemaName = cinema.name;
        show.cinemaId = cinema.cinemaId;
        show.movieTitle = movie.title;
        movie.shows.push(show);
      });
    });
  }
});

// Initialize show seats memory store for every single screening
const showSeats = {};
movies.forEach(movie => {
  movie.shows.forEach(show => {
    showSeats[show.id] = generateSeatsForShow();
  });
});

// Bookings store
const bookings = [];

// Audit logs ring buffer (stores up to 200 concurrency & reservation events)
const MAX_AUDIT_LOGS = 200;
const auditLogs = [];

function logAuditEvent(event) {
  const logItem = {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    ms: Date.now(),
    ...event
  };
  auditLogs.unshift(logItem);
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.pop();
  }
  return logItem;
}

module.exports = {
  movies,
  showSeats,
  bookings,
  auditLogs,
  logAuditEvent,
  generateSeatsForShow
};
