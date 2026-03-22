// bot.js
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const db = require('./database');
const path = require('path');

// Initialize database
db.initDb().then(() => console.log('Database ready'));

// Create Telegraf bot
const bot = new Telegraf(config.BOT_TOKEN);

// Create Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (mini app)
app.use(express.static(path.join(__dirname, 'public')));

// ---- Telegram Bot Handlers ----
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Register', 'register')],
    [Markup.button.callback('🎮 Play', 'play')],
    [Markup.button.callback('💰 Deposit', 'deposit')],
    [Markup.button.callback('💳 Balance', 'balance')],
    [Markup.button.callback('💸 Withdraw', 'withdraw')],
    [Markup.button.callback('ℹ️ Instruction', 'instruction')],
    [Markup.button.callback('📞 Support', 'support')],
    [Markup.button.callback('👥 Invite', 'invite')],
    [Markup.button.callback('🤝 Register As Agent', 'agent')],
    [Markup.button.callback('👥 Invite Sub-Agent', 'invitesubagent')],
    [Markup.button.callback('🏷️ Sale', 'sale')],
]);

bot.start(async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (user) {
        await ctx.reply('Welcome back! Use the menu below.', mainMenu);
    } else {
        await ctx.reply(
            'Welcome to Vamos Bingo Bot!\n\nPlease click the button "Register Now" below to complete your registration.',
            Markup.inlineKeyboard([Markup.button.callback('Register Now', 'register')])
        );
    }
});

bot.action('register', async (ctx) => {
    await ctx.reply(
        'Please share your phone number to complete registration.',
        Markup.keyboard([Markup.button.contactRequest('Share your phone number')]).resize()
    );
    await ctx.answerCbQuery();
});

bot.on('contact', async (ctx) => {
    const contact = ctx.message.contact;
    if (contact.user_id !== ctx.from.id) {
        await ctx.reply('Please share your own phone number.');
        return;
    }
    const existing = await db.getUser(contact.user_id);
    if (existing) {
        await ctx.reply('You are already registered.');
        return;
    }
    await db.registerUser(contact.user_id, contact.phone_number, contact.first_name);
    await ctx.reply(
        `You have been successfully registered!\nA 10 birr welcome gift has been deposited into your account.\nClick /play to start the game.`,
        mainMenu
    );
});

bot.action('play', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first using /start');
        return;
    }
    const { withdrawable, nonWithdrawable } = await db.getBalance(user.user_id);
    const total = withdrawable + nonWithdrawable;
    if (total < config.STAKE_AMOUNT) {
        await ctx.reply('Insufficient balance. Please deposit first.');
        return;
    }
    // Deduct stake
    if (nonWithdrawable >= config.STAKE_AMOUNT) {
        await db.updateBalance(user.user_id, -config.STAKE_AMOUNT, false);
    } else {
        const remaining = config.STAKE_AMOUNT - nonWithdrawable;
        await db.updateBalance(user.user_id, -nonWithdrawable, false);
        await db.updateBalance(user.user_id, -remaining, true);
    }
    // Add to game
    let game = await db.getWaitingGame();
    if (!game) {
        const gameId = await db.createGame();
        game = { id: gameId, status: 'waiting' };
    }
    // Generate a random bingo card (5x5, free center)
    const card = generateCard();
    await db.addPlayerToGame(game.id, user.user_id, card);
    if (game.status === 'waiting') {
        await db.startGame(game.id);
    }
    // Send web app button
    await ctx.reply(
        '🎉 Best of luck on your gaming adventure! 🎉',
        Markup.inlineKeyboard([
            Markup.button.webApp('Play-10', `${config.WEBAPP_URL}/webapp?userId=${user.user_id}&gameId=${game.id}`),
            Markup.button.callback('◀️ Back', 'back_main')
        ])
    );
    await ctx.answerCbQuery();
});

bot.action('back_main', async (ctx) => {
    await ctx.reply('Main menu', mainMenu);
    await ctx.answerCbQuery();
});

bot.action('balance', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    const { withdrawable, nonWithdrawable } = await db.getBalance(user.user_id);
    await ctx.reply(
        `Your Current Account Balance!\n\nName: ${user.name}\nPhone Number: ${user.phone}\nWithdrawable Balance: ${withdrawable.toFixed(1)}\nNon-Withdrawable Balance: ${nonWithdrawable.toFixed(1)}\nTotal Balance: ${(withdrawable + nonWithdrawable).toFixed(1)}`
    );
    await ctx.answerCbQuery();
});

bot.action('deposit', async (ctx) => {
    await ctx.reply('Deposit feature coming soon. Please contact support.');
    await ctx.answerCbQuery();
});

bot.action('withdraw', async (ctx) => {
    await ctx.reply('Withdraw feature coming soon. Please contact support.');
    await ctx.answerCbQuery();
});

bot.action('instruction', async (ctx) => {
    const text = "🎯 How to play Bingo:\n\n1. Click /play to join a game.\n2. A 5x5 card will be generated.\n3. Numbers are drawn every 3 seconds.\n4. Mark numbers on your card as they are called.\n5. When you complete a row, column, diagonal, or all four corners, click BINGO!\n6. The first player(s) to get BINGO win the prize pool.";
    await ctx.reply(text);
    await ctx.answerCbQuery();
});

bot.action('support', async (ctx) => {
    await ctx.reply('For support, please contact @VamosBingoSupport (not created yet).');
    await ctx.answerCbQuery();
});

bot.action('invite', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    const link = `https://t.me/${ctx.bot.botInfo.username}?start=${user.invite_code}`;
    await ctx.reply(`🎁 Invite friends and earn!\n\nYour referral link:\n${link}`);
    await ctx.answerCbQuery();
});

bot.action('agent', async (ctx) => {
    await ctx.reply('To become an agent, please contact support.');
    await ctx.answerCbQuery();
});

bot.action('invitesubagent', async (ctx) => {
    await ctx.reply('You are not registered as a super agent.');
    await ctx.answerCbQuery();
});

bot.action('sale', async (ctx) => {
    await ctx.reply('No agent account found.');
    await ctx.answerCbQuery();
});

// Helper: generate random bingo card
function generateCard() {
    const numbers = Array.from({ length: config.MAX_NUMBER }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    const card = [];
    for (let i = 0; i < 5; i++) {
        card.push(numbers.slice(i * 5, (i + 1) * 5));
    }
    card[2][2] = 0; // free space
    return card;
}

// ---- API endpoints for mini app ----
app.get('/webapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/game/status', async (req, res) => {
    const { userId, gameId } = req.query;
    if (!userId || !gameId) {
        return res.status(400).json({ error: 'Missing parameters' });
    }
    const game = await db.getGameState(parseInt(gameId));
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    const card = await db.getPlayerCard(parseInt(gameId), parseInt(userId));
    if (!card) {
        return res.status(403).json({ error: 'Player not in this game' });
    }
    res.json({
        status: game.status,
        called_numbers: JSON.parse(game.called_numbers),
        card: card,
        prize_pool: game.prize_pool,
        players: JSON.parse(game.players)
    });
});

app.post('/api/game/bingo', async (req, res) => {
    const { userId, gameId } = req.body;
    if (!userId || !gameId) {
        return res.status(400).json({ error: 'Missing parameters' });
    }
    const game = await db.getGameState(parseInt(gameId));
    if (!game || game.status !== 'active') {
        return res.status(400).json({ error: 'Game not active' });
    }
    const players = JSON.parse(game.players);
    if (!players.includes(parseInt(userId))) {
        return res.status(403).json({ error: 'Not a player in this game' });
    }
    const card = await db.getPlayerCard(parseInt(gameId), parseInt(userId));
    const called = JSON.parse(game.called_numbers);
    // Check bingo pattern
    const marked = Array(5).fill().map(() => Array(5).fill(false));
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            if (card[i][j] !== 0 && called.includes(card[i][j])) {
                marked[i][j] = true;
            }
        }
    }
    marked[2][2] = true; // free space always marked
    if (!checkBingo(marked)) {
        return res.status(400).json({ error: 'No valid bingo pattern' });
    }
    // Check if game already has winners
    if (game.winner_ids) {
        return res.status(400).json({ error: 'Game already ended' });
    }
    // End game with this winner
    await db.endGame(game.id, [parseInt(userId)]);
    const prize = game.prize_pool; // divided among winners (here single)
    res.json({ success: true, prize: prize });
});

function checkBingo(marked) {
    // Check rows
    for (let i = 0; i < 5; i++) {
        if (marked[i].every(v => v)) return true;
    }
    // Check columns
    for (let j = 0; j < 5; j++) {
        let col = true;
        for (let i = 0; i < 5; i++) {
            if (!marked[i][j]) { col = false; break; }
        }
        if (col) return true;
    }
    // Diagonals
    let diag1 = true, diag2 = true;
    for (let i = 0; i < 5; i++) {
        if (!marked[i][i]) diag1 = false;
        if (!marked[i][4-i]) diag2 = false;
    }
    if (diag1 || diag2) return true;
    // Corners
    if (marked[0][0] && marked[0][4] && marked[4][0] && marked[4][4]) return true;
    return false;
}

// ---- Background number drawing (every 3 seconds) ----
cron.schedule(`*/${config.DRAW_INTERVAL} * * * * *`, async () => {
    const game = await db.getCurrentGame();
    if (!game) return;
    const called = JSON.parse(game.called_numbers);
    if (called.length >= config.MAX_NUMBER) return;
    const remaining = Array.from({ length: config.MAX_NUMBER }, (_, i) => i + 1).filter(n => !called.includes(n));
    const newNumber = remaining[Math.floor(Math.random() * remaining.length)];
    await db.addCalledNumber(game.id, newNumber);
    // Check winners
    const players = JSON.parse(game.players);
    const updatedCalled = [...called, newNumber];
    const winners = [];
    for (const pid of players) {
        const card = await db.getPlayerCard(game.id, pid);
        if (!card) continue;
        const marked = Array(5).fill().map(() => Array(5).fill(false));
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
                if (card[i][j] !== 0 && updatedCalled.includes(card[i][j])) {
                    marked[i][j] = true;
                }
            }
        }
        marked[2][2] = true;
        if (checkBingo(marked)) {
            winners.push(pid);
        }
    }
    if (winners.length > 0) {
        await db.endGame(game.id, winners);
        // Optionally send notifications to winners via Telegram
    }
});

// ---- Webhook endpoint for Telegram ----
app.post(`/webhook/${config.BOT_TOKEN}`, (req, res) => {
    bot.handleUpdate(req.body, res);
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Set Telegram webhook
    const webhookUrl = `${config.WEBAPP_URL}/webhook/${config.BOT_TOKEN}`;
    bot.telegram.setWebhook(webhookUrl)
        .then(() => console.log('Webhook set to', webhookUrl))
        .catch(err => console.error('Webhook error', err));
});