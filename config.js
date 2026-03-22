// config.js
module.exports = {
    BOT_TOKEN: process.env.BOT_TOKEN || '8341888497:AAG40gdaVtxaQcaOutux5Iwl2Mq_Nc9xZ3o', // replace with your real token after revoking
    ADMIN_ID: 5746880638,
    ADMINS: [5746880638], // add other admin IDs if needed
    STAKE_AMOUNT: 10,
    MAX_CARDS_PER_USER: 3,   // how many cards a single user can buy in one game
    DRAW_INTERVAL: 3,        // seconds between number draws
    MAX_NUMBER: 75,
    WEBAPP_URL: process.env.WEBAPP_URL || 'https://vamos-bingo-bot.onrender.com'
};