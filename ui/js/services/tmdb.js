// ui/js/services/tmdb.js

// TODO: Replace with your actual TMDB API Key (v3 auth)
const TMDB_API_KEY = "a2328efa3f7fc8a1565688992426b9e4";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

/**
 * Fetches now playing movies from TMDB API.
 * 
 * @returns {Promise<Array>} List of movies
 */
export async function fetchNowPlayingMovies() {
  if (TMDB_API_KEY === "YOUR_TMDB_API_KEY") {
    console.warn("TMDB API Key is missing. Using local mock data instead.");
    return null; // Return null so app.js falls back to local data
  }

  try {
    const response = await fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${TMDB_API_KEY}&language=en-US&page=1`);
    if (!response.ok) throw new Error("Network response was not ok");
    const data = await response.json();
    return data.results;
  } catch (error) {
    console.error("Failed to fetch movies from TMDB:", error);
    return null;
  }
}

/**
 * Transforms TMDB movie format to CinePulse format
 * @param {Object} tmdbMovie 
 * @returns {Object}
 */
export function formatTMDBMovieForCinePulse(tmdbMovie) {
  return {
    id: `tmdb_${tmdbMovie.id}`,
    title: tmdbMovie.title,
    synopsis: tmdbMovie.overview,
    poster: `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}`,
    banner: `https://image.tmdb.org/t/p/original${tmdbMovie.backdrop_path}`,
    score: tmdbMovie.vote_average.toFixed(1),
    votes: tmdbMovie.vote_count,
    rating: tmdbMovie.adult ? "A" : "UA", 
    duration: "120 min", // TMDB /now_playing doesn't include runtime, would need a detail fetch
    genre: "Action", // Would need genre mapping
    languages: ["English", "IMAX 2D"],
    tagline: "Experience the magic of cinema.",
    director: "Unknown",
    cast: "Unknown Cast"
  };
}
