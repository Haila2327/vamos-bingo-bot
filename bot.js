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
        // Check if start parameter is a referral code
        const referralCode = ctx.startPayload;
        ctx.session = { referralCode };
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
    const referrerCode = ctx.session?.referralCode;
    await db.registerUser(contact.user_id, contact.phone_number, contact.first_name, referrerCode);
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

// --- Deposit flow ---
bot.action('deposit', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Telebirr', 'deposit_telebirr')],
        [Markup.button.callback('CBE Birr', 'deposit_cbe')],
        [Markup.button.callback('◀️ Back', 'back_main')]
    ]);
    await ctx.reply('Please select the bank option you wish to use for the top-up.', keyboard);
    await ctx.answerCbQuery();
});

bot.action('deposit_telebirr', async (ctx) => {
    ctx.session.depositMethod = 'telebirr';
    await ctx.reply(
        "Telebirr Account: 0977444245 -\n\n" +
        "Instructions:\n" +
        "1. Send the amount to the above Telebirr account.\n" +
        "2. After payment, you will receive an SMS from Telebirr.\n" +
        "3. Copy the SMS and paste it here as a reply.\n\n" +
        "If you have any issues, contact @VamosBingoSupport"
    );
    await ctx.answerCbQuery();
});

bot.action('deposit_cbe', async (ctx) => {
    ctx.session.depositMethod = 'cbe';
    await ctx.reply(
        "CBE-Birr Account: 0977446445 -\n\n" +
        "Instructions:\n" +
        "1. Send the amount to the above CBE-Birr account.\n" +
        "2. After payment, you will receive an SMS from CBE.\n" +
        "3. Copy the SMS and paste it here as a reply.\n\n" +
        "If you have any issues, contact @VamosBingoSupport"
    );
    await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (ctx.session.depositMethod) {
        // This is a deposit SMS
        const method = ctx.session.depositMethod;
        const amount = extractAmountFromSMS(text); // we need a simple parser
        if (!amount) {
            await ctx.reply('We could not detect the amount in your SMS. Please include the amount clearly.');
            return;
        }
        await db.createDeposit(ctx.from.id, amount, method, text);
        await ctx.reply('Thank you! Your deposit request has been submitted and will be processed shortly.');
        delete ctx.session.depositMethod;
    } else if (ctx.session.awaitingWithdrawAmount) {
        // This is a withdrawal amount
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('Please enter a valid positive number.');
            return;
        }
        const user = await db.getUser(ctx.from.id);
        const { withdrawable } = await db.getBalance(user.user_id);
        if (withdrawable < amount) {
            await ctx.reply(`Insufficient fund. user: ${user.phone}, amount: ${amount}`);
            return;
        }
        await db.createWithdrawal(ctx.from.id, amount);
        await ctx.reply(`Withdrawal request for ${amount} birr has been submitted. Our team will process it soon.`);
        delete ctx.session.awaitingWithdrawAmount;
    }
});

function extractAmountFromSMS(sms) {
    // Simple regex: look for a number followed by "birr" or just a number
    const match = sms.match(/(\d+(?:\.\d+)?)\s*(birr|ETB|Br)/i);
    if (match) return parseFloat(match[1]);
    // fallback: just the first number in the SMS
    const fallback = sms.match(/\d+(?:\.\d+)?/);
    return fallback ? parseFloat(fallback[0]) : null;
}

// --- Withdrawal flow ---
bot.action('withdraw', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    await ctx.reply('Please enter the amount you wish to withdraw.');
    ctx.session.awaitingWithdrawAmount = true;
    await ctx.answerCbQuery();
});

// --- Balance ---
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

// --- Instruction (full text from original bot) ---
bot.action('instruction', async (ctx) => {
    const text = `### የበንግ ጨዋታ ህጎች መጨምች ካርድ  
ጨዋታውን ለመጀመር ከሚመጣልን ከ1-400 የመጨምች ካርድ ውስጥ አንዱን እንመርጣሉን የመጨምች ካርዱ ላይ በቀይ ቀለም የተመረጡ ቆጥሮች የሚያሳዩት መጨምች ካርድ በሌላ ተጨዋች መመረጡን ነው  
የመጨምች ካርድ ስንነካው ከታች በኩል ካርድ ቆጥሩ የሚያዘዉን መጨምች ካርድ ያሳየፍል ወደ ጨዋታው ለመግባት የምንፈልገዉን ካርድ ከመረጥን ለምክንያ የተሰጠው ለኮንድ ክድ ሲሆን ቀጥታ ወደ ጨዋታ ያስገባፍል  

### ጨዋታ  
ወደ ጨዋታው ስንገባ በመረጥነው የካርድ ቆጥር መሰረት የመጨምች ካርድ እናገጃለን ከላይ በቀኝ በኩል ጨዋታው ለመጀመር ያለዉን ቀሪ ሴኮንድ መቆጠር ይጀምራል  
ጨዋታው ሲጀምር የተለያዩ ቆጥሮች ከ1 እስከ 75 መጥራት ይጀምራል  
የሚጠራው ቆጥር የጁ መጨምች ካርድ ዉስጥ ካለ የተጠራዉን ቆጥር ከሌስ በማረግ መምረጥ እንችላለን  
የመረጥነዉን ቆጥር ማጥፋት ከፈለግን መልሶን እራሱን ቆጠር ክሌክ በማረግ ማጥፋት እንችላለን  

### አሸፍሬ  
ቆጥሮቹ ሲጠሩ ከመጨምች ካርዱችን ላይ እየመረጥን ወደን ወይም ወይታች ወይም ወደሁለቱም አግደሚ ወይም አራቱን ማእዘናት ከመረጥን ወደኢኤስ ከታች በኩል bingo የሚለዉን በመንካት ማሸነፍ እንችላለን  
ወደን ወይም ወይታች ወደም ወደሁለቱም አግደሚ ወይም አራቱን ማእዘናት ሳይጠሩ bingo የሚለዉን ክሌክ ካደረግን ከጨዋታው እንታገዳለን  
ሁለት ወይም ከዚያ በላይ ተጨዋችች እኩል ቢያሸንፉ ደራሹ ላ ቆጥራቸው ይከፈልል።`;
    await ctx.reply(text, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});

// --- Support ---
bot.action('support', async (ctx) => {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('Contact Support', 'https://t.me/VamosBingoSupport')]
    ]);
    await ctx.reply('Please click the button below to get in touch with our support team.', keyboard);
    await ctx.answerCbQuery();
});

// --- Invite ---
bot.action('invite', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    const link = `https://t.me/${ctx.bot.botInfo.username}?start=${user.invite_code}`;
    await ctx.reply(`Here is your referral link:\n${link}\n\nShare it with your friends!`);
    await ctx.answerCbQuery();
});

// --- Agent Registration ---
bot.action('agent', async (ctx) => {
    await ctx.reply('To become an agent, please contact our support team using @VamosBingoSupport');
    await ctx.answerCbQuery();
});

// --- Invite Sub-Agent (only for super agents) ---
bot.action('invitesubagent', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user) {
        await ctx.reply('Please register first.');
        return;
    }
    if (user.agent_level < 2) {
        await ctx.reply('You are not registered as a super agent. Please register as a super agent first.');
    } else {
        // Provide link for sub-agent registration
        await ctx.reply('Sub-agent registration link will be provided soon.');
    }
    await ctx.answerCbQuery();
});

// --- Sale ---
bot.action('sale', async (ctx) => {
    const user = await db.getUser(ctx.from.id);
    if (!user || user.agent_level === 0) {
        await ctx.reply('No agent account found');
    } else {
        await ctx.reply('Sale feature coming soon.');
    }
    await ctx.answerCbQuery();
});

bot.action('back_main', async (ctx) => {
    await ctx.reply('Main menu', mainMenu);
    await ctx.answerCbQuery();
});

// --- Admin Commands ---
// Only users in config.ADMINS can use these
bot.command('admin', async (ctx) => {
    if (!config.ADMINS.includes(ctx.from.id)) {
        await ctx.reply('You are not an admin.');
        return;
    }
    const deposits = await db.getPendingDeposits();
    const withdrawals = await db.getPendingWithdrawals();
    let msg = '📋 *Pending Approvals*\n\n';
    if (deposits.length) {
        msg += '*Deposits:*\n';
        for (const d of deposits) {
            msg += `ID: ${d.id} | User: ${d.user_id} | Amount: ${d.amount} | Method: ${d.method}\n`;
        }
    } else {
        msg += 'No pending deposits.\n';
    }
    if (withdrawals.length) {
        msg += '\n*Withdrawals:*\n';
        for (const w of withdrawals) {
            msg += `ID: ${w.id} | User: ${w.user_id} | Amount: ${w.amount}\n`;
        }
    } else {
        msg += '\nNo pending withdrawals.\n';
    }
    msg += '\nUse:\n/approve_deposit <id>\n/reject_deposit <id>\n/approve_withdraw <id>\n/reject_withdraw <id>';
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('approve_deposit', async (ctx) => {
    if (!config.ADMINS.includes(ctx.from.id)) return;
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
        await ctx.reply('Usage: /approve_deposit <id>');
        return;
    }
    await db.approveDeposit(id, ctx.from.id);
    await ctx.reply(`Deposit ${id} approved.`);
});

bot.command('reject_deposit', async (ctx) => {
    if (!config.ADMINS.includes(ctx.from.id)) return;
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
        await ctx.reply('Usage: /reject_deposit <id>');
        return;
    }
    await db.rejectDeposit(id);
    await ctx.reply(`Deposit ${id} rejected.`);
});

bot.command('approve_withdraw', async (ctx) => {
    if (!config.ADMINS.includes(ctx.from.id)) return;
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
        await ctx.reply('Usage: /approve_withdraw <id>');
        return;
    }
    await db.approveWithdrawal(id, ctx.from.id);
    await ctx.reply(`Withdrawal ${id} approved.`);
});

bot.command('reject_withdraw', async (ctx) => {
    if (!config.ADMINS.includes(ctx.from.id)) return;
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
        await ctx.reply('Usage: /reject_withdraw <id>');
        return;
    }
    await db.rejectWithdrawal(id);
    await ctx.reply(`Withdrawal ${id} rejected.`);
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