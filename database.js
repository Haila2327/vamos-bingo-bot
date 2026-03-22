// database.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const crypto = require('crypto');

let db;

async function initDb() {
    db = await open({
        filename: './bingo.db',
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            phone TEXT UNIQUE,
            name TEXT,
            registered INTEGER DEFAULT 0,
            withdrawable REAL DEFAULT 0,
            non_withdrawable REAL DEFAULT 0,
            referrer_id INTEGER,
            agent_level INTEGER DEFAULT 0,
            invite_code TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount REAL,
            method TEXT,
            sms_text TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount REAL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT DEFAULT 'waiting',
            called_numbers TEXT DEFAULT '[]',
            players TEXT DEFAULT '[]',
            cards TEXT DEFAULT '{}',
            winner_ids TEXT,
            prize_pool REAL DEFAULT 0,
            started_at DATETIME,
            ended_at DATETIME,
            used_cards TEXT DEFAULT '[]'
        );
    `);
    // Add used_cards column if not exists (for older installations)
    await db.exec(`ALTER TABLE games ADD COLUMN used_cards TEXT DEFAULT '[]'`).catch(() => {});
    console.log('Database initialized');
}

// --- User functions ---
async function getUser(userId) {
    return db.get('SELECT * FROM users WHERE user_id = ?', userId);
}

async function registerUser(userId, phone, name, referrerCode = null) {
    const inviteCode = crypto.randomBytes(4).toString('hex');
    let referrerId = null;
    if (referrerCode) {
        const ref = await db.get('SELECT user_id FROM users WHERE invite_code = ?', referrerCode);
        if (ref) referrerId = ref.user_id;
    }
    await db.run(
        'INSERT INTO users (user_id, phone, name, registered, withdrawable, non_withdrawable, referrer_id, invite_code) VALUES (?, ?, ?, 1, 0, 0, ?, ?)',
        userId, phone, name, referrerId, inviteCode
    );
    // Welcome bonus
    await db.run('UPDATE users SET non_withdrawable = non_withdrawable + 10 WHERE user_id = ?', userId);
    // Referral bonus to referrer
    if (referrerId) {
        await db.run('UPDATE users SET withdrawable = withdrawable + 5 WHERE user_id = ?', referrerId);
    }
    return true;
}

async function updateBalance(userId, amount, withdrawable = true) {
    const field = withdrawable ? 'withdrawable' : 'non_withdrawable';
    await db.run(`UPDATE users SET ${field} = ${field} + ? WHERE user_id = ?`, amount, userId);
}

async function getBalance(userId) {
    const user = await getUser(userId);
    return { withdrawable: user?.withdrawable || 0, nonWithdrawable: user?.non_withdrawable || 0 };
}

// --- Deposit functions ---
async function createDeposit(userId, amount, method, smsText) {
    const result = await db.run(
        'INSERT INTO deposits (user_id, amount, method, sms_text, status) VALUES (?, ?, ?, ?, "pending")',
        userId, amount, method, smsText
    );
    return result.lastID;
}

async function getPendingDeposits() {
    return db.all('SELECT * FROM deposits WHERE status = "pending" ORDER BY created_at DESC');
}

async function approveDeposit(depositId, adminId) {
    const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', depositId);
    if (!deposit || deposit.status !== 'pending') return false;
    await updateBalance(deposit.user_id, deposit.amount, false);
    await db.run('UPDATE deposits SET status = "approved" WHERE id = ?', depositId);
    return true;
}

async function rejectDeposit(depositId) {
    await db.run('UPDATE deposits SET status = "rejected" WHERE id = ?', depositId);
}

// --- Withdrawal functions ---
async function createWithdrawal(userId, amount) {
    const result = await db.run(
        'INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, "pending")',
        userId, amount
    );
    return result.lastID;
}

async function getPendingWithdrawals() {
    return db.all('SELECT * FROM withdrawals WHERE status = "pending" ORDER BY created_at DESC');
}

async function approveWithdrawal(withdrawalId, adminId) {
    const withdrawal = await db.get('SELECT * FROM withdrawals WHERE id = ?', withdrawalId);
    if (!withdrawal || withdrawal.status !== 'pending') return false;
    await updateBalance(withdrawal.user_id, -withdrawal.amount, true);
    await db.run('UPDATE withdrawals SET status = "approved" WHERE id = ?', withdrawalId);
    return true;
}

async function rejectWithdrawal(withdrawalId) {
    await db.run('UPDATE withdrawals SET status = "rejected" WHERE id = ?', withdrawalId);
}

// --- Agent functions ---
async function setAgentLevel(userId, level) {
    await db.run('UPDATE users SET agent_level = ? WHERE user_id = ?', level, userId);
}

async function getSubAgents(agentId) {
    return db.all('SELECT * FROM users WHERE referrer_id = ? AND agent_level > 0', agentId);
}

async function addAgentCommission(agentId, amount) {
    await updateBalance(agentId, amount, true);
}

// --- Game functions ---
async function getCurrentGame() {
    return db.get('SELECT * FROM games WHERE status = "active" ORDER BY id DESC LIMIT 1');
}

async function getWaitingGame() {
    return db.get('SELECT * FROM games WHERE status = "waiting" ORDER BY id DESC LIMIT 1');
}

async function createGame() {
    const result = await db.run('INSERT INTO games (status, called_numbers, players, cards) VALUES ("waiting", "[]", "[]", "{}")');
    return result.lastID;
}

async function addPlayerToGame(gameId, userId, card) {
    const game = await db.get('SELECT players, cards FROM games WHERE id = ?', gameId);
    let players = JSON.parse(game.players);
    let cards = JSON.parse(game.cards);
    if (!players.includes(userId)) {
        players.push(userId);
        cards[userId] = card;
        await db.run('UPDATE games SET players = ?, cards = ? WHERE id = ?', JSON.stringify(players), JSON.stringify(cards), gameId);
    }
}

async function startGame(gameId) {
    await db.run('UPDATE games SET status = "active", called_numbers = "[]", started_at = CURRENT_TIMESTAMP WHERE id = ?', gameId);
}

async function addCalledNumber(gameId, number) {
    const game = await db.get('SELECT called_numbers FROM games WHERE id = ?', gameId);
    let called = JSON.parse(game.called_numbers);
    if (!called.includes(number)) {
        called.push(number);
        await db.run('UPDATE games SET called_numbers = ? WHERE id = ?', JSON.stringify(called), gameId);
        return true;
    }
    return false;
}

async function endGame(gameId, winners) {
    const game = await db.get('SELECT prize_pool FROM games WHERE id = ?', gameId);
    const prizePerWinner = game.prize_pool / winners.length;
    for (const winnerId of winners) {
        await updateBalance(winnerId, prizePerWinner, true);
        // Give commission to referrer/agent if any
        const user = await getUser(winnerId);
        if (user && user.referrer_id) {
            const referrer = await getUser(user.referrer_id);
            if (referrer && referrer.agent_level > 0) {
                await addAgentCommission(referrer.user_id, prizePerWinner * 0.1);
            }
        }
    }
    await db.run('UPDATE games SET status = "ended", winner_ids = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?',
        JSON.stringify(winners), gameId);
}

async function getGameState(gameId) {
    return db.get('SELECT * FROM games WHERE id = ?', gameId);
}

async function getPlayerCard(gameId, userId) {
    const game = await db.get('SELECT cards FROM games WHERE id = ?', gameId);
    if (!game) return null;
    const cards = JSON.parse(game.cards);
    return cards[userId];
}

// --- New functions for card selection ---
async function isCardTaken(gameId, cardNumber) {
    const game = await db.get('SELECT used_cards FROM games WHERE id = ?', gameId);
    if (!game) return false;
    const used = JSON.parse(game.used_cards);
    return used.includes(cardNumber);
}

async function addUsedCard(gameId, cardNumber) {
    const game = await db.get('SELECT used_cards FROM games WHERE id = ?', gameId);
    const used = JSON.parse(game.used_cards);
    if (!used.includes(cardNumber)) {
        used.push(cardNumber);
        await db.run('UPDATE games SET used_cards = ? WHERE id = ?', JSON.stringify(used), gameId);
    }
}

async function getUserCardsInGame(gameId, userId) {
    const game = await db.get('SELECT cards FROM games WHERE id = ?', gameId);
    if (!game) return [];
    const cards = JSON.parse(game.cards);
    // cards is an object keyed by userId; each value is a card array.
    // We need to count how many cards this user has.
    // But currently we store one card per user. We'll extend to support multiple.
    // For now, we count how many entries for this user? Actually, the structure is one card per user.
    // To allow multiple cards, we'd need to change schema. For simplicity, we'll implement per-user card limit by storing an array of cards per user.
    // Let's adapt: store cards as an object: { "userId": [card1, card2, ...] }
    // We'll rewrite addPlayerToGame and getUserCardsInGame accordingly.
    // Since this is a big change, we'll create new functions for the new schema.
    // For now, we'll just return the card if exists, else empty array.
    const userCards = cards[userId];
    return userCards ? (Array.isArray(userCards) ? userCards : [userCards]) : [];
}

// Updated addPlayerCard – adds a card for the user (supports multiple)
async function addPlayerCard(gameId, userId, card) {
    const game = await db.get('SELECT players, cards FROM games WHERE id = ?', gameId);
    let players = JSON.parse(game.players);
    let cards = JSON.parse(game.cards);
    if (!players.includes(userId)) {
        players.push(userId);
    }
    if (!cards[userId]) {
        cards[userId] = [];
    }
    cards[userId].push(card);
    await db.run('UPDATE games SET players = ?, cards = ? WHERE id = ?', JSON.stringify(players), JSON.stringify(cards), gameId);
}

async function getPlayerCards(gameId, userId) {
    const game = await db.get('SELECT cards FROM games WHERE id = ?', gameId);
    if (!game) return [];
    const cards = JSON.parse(game.cards);
    return cards[userId] || [];
}

module.exports = {
    initDb,
    getUser,
    registerUser,
    updateBalance,
    getBalance,
    createDeposit,
    getPendingDeposits,
    approveDeposit,
    rejectDeposit,
    createWithdrawal,
    getPendingWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    setAgentLevel,
    getSubAgents,
    addAgentCommission,
    getCurrentGame,
    getWaitingGame,
    createGame,
    addPlayerCard,           // new
    getPlayerCards,          // new
    startGame,
    addCalledNumber,
    endGame,
    getGameState,
    getPlayerCard,
    isCardTaken,
    addUsedCard,
    getUserCardsInGame       // helper
};