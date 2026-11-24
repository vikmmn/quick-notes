// Settings for Serendipity.
window.APP_CONFIG = {
  // The Google sign-in key, shared with 2nd Brain Notes. It is approved for https://vikmmn.github.io only.
  CLIENT_ID: '171371799928-o231cvpnqtpln2gqekntfqgse9t2g8s5.apps.googleusercontent.com',

  // The address the real app runs at. Anywhere else (for example inside Claude) it opens in demo mode.
  APP_ORIGIN: 'https://vikmmn.github.io',

  // Everyone's notes go to a "Serendipity" folder in their own Drive, made on first sign-in (marked so the app finds it
  // again on any device). New notes go to its Inbox.
  ROOT_FOLDER_NAME: 'Serendipity',
  SUBFOLDERS: ['Inbox'],
  // Notes made before that went to Notes inside this "03. Readables" folder; if that folder is there, it stays the home.
  READABLES_FOLDER_ID: '1L3bcLlOXz8fth-ID5VWIvAOX1kXm4cSh',
  NOTES_FOLDER_NAME: 'Notes',

  // The sign-in helper (server/sign-in-helper.js on Cloudflare) that keeps you signed in. Empty = one-hour sign-ins.
  TOKEN_SERVER: 'https://quick-notes-signin.vikrammaan-s-trehan.workers.dev',

  // Bump together with VERSION in sw.js for every approved release.
  VERSION: '3.37.0'
};
