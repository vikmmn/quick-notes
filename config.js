// Settings for Quick Notes.
window.APP_CONFIG = {
  // The Google sign-in key, shared with 2nd Brain Notes. It is approved for https://vikmmn.github.io only.
  CLIENT_ID: '171371799928-o231cvpnqtpln2gqekntfqgse9t2g8s5.apps.googleusercontent.com',

  // The address the real app runs at. Anywhere else (for example inside Claude) it opens in demo mode.
  APP_ORIGIN: 'https://vikmmn.github.io',

  // The inner "03. Readables" folder (the one that holds Books, Course and Papers).
  READABLES_FOLDER_ID: '1L3bcLlOXz8fth-ID5VWIvAOX1kXm4cSh',
  // Created inside Readables on first sign-in, with these folders inside it. New notes go to the first one.
  NOTES_FOLDER_NAME: 'Notes',
  SUBFOLDERS: ['Inbox', 'Keep', 'Notion'],

  // Bump together with VERSION in sw.js for every approved release.
  VERSION: '2.1.4'
};
