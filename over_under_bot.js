let tradeActive = false; // Track if a trade is currently open
// Always get hour in Sri Lanka time
function getColomboHour(date = new Date()) {
    return Number(date.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Colombo' }));
}
// over_under_bot.js
// Node.js Deriv Over/Under Trading Bot (24/7 VPS-ready)
// Logic adapted from browser-based over_under.js

require('dotenv').config();
const WebSocket = require('ws');
const fs = require('fs');

// --- CONFIG ---
const ACCOUNT_TOKEN = process.env.ACCOUNT_TOKEN || '';
const INITIAL_STAKE_PERCENT = parseFloat(process.env.INITIAL_STAKE_PERCENT) || 0.35; // % of balance
const DAY_TARGET_PERCENT = parseFloat(process.env.DAY_TARGET_PERCENT) || 5; // %
const SESSION_TARGET_PERCENT = parseFloat(process.env.SESSION_TARGET_PERCENT) || 2; // %
const MARTINGALE_MULTIPLIER = parseFloat(process.env.MARTINGALE_MULTIPLIER) || 3;
const MARKET_LIST = ['R_10', 'R_50'];
const DIGIT = 2; // Over 2
const TICK_DURATION = 1;
const TRADE_INTERVAL_MS = 10000; // 10s between trades
const RECOVERY_TRIGGER_DIGITS = [0,1,2];

// --- STATE ---
let capital = 0;
let updatedBalance = 0;
let initialAmountPerTrade = 0;
let stake = 0;
let dayStartCapital = 0;
let dayTarget = 0;
let sessionTarget = 0;
let currentProfit = 0;
let currentLoss = 0;
let lostCountInRow = 0;
let recoveryStake = 0;
let isWaitingForRecovery = false;
let ws = null;
let market = MARKET_LIST[0];
let logFile = 'logs/over_under_bot_log.txt';
// --- Persistent day tracking ---
let lastDay = null;
let resumeHour = 7; // 7:00 AM local time
let pausedForDay = false;

function log(msg) {
    const now = new Date();
    const out = `[${now.toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}] ${msg}`;
    console.log(out);
    fs.appendFileSync(logFile, out + '\n');
}

function getRandomMarket(current) {
    let m = MARKET_LIST[Math.floor(Math.random()*MARKET_LIST.length)];
    return m === current ? MARKET_LIST[(MARKET_LIST.indexOf(m)+1)%MARKET_LIST.length] : m;
}

function calcStake(status, lastLossAmount) {
    if (status === 'Loss') {
        return Number((stake * MARTINGALE_MULTIPLIER).toFixed(2));
    } else if (status === 'Recovery') {
        return Number((Math.abs(lastLossAmount) * MARTINGALE_MULTIPLIER).toFixed(2));
    }
    return initialAmountPerTrade;
}

function resetDayTargets() {
    dayStartCapital = capital;
    dayTarget = dayStartCapital * (DAY_TARGET_PERCENT/100); // Always 10% of starting capital
    sessionTarget = dayStartCapital * (SESSION_TARGET_PERCENT/100);
    currentProfit = 0;
    currentLoss = 0;
    lostCountInRow = 0;
    // Use Sri Lanka date for lastDay (YYYY-MM-DD)
    const now = new Date();
    const colomboDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    lastDay = colomboDate.getFullYear() + '-' + String(colomboDate.getMonth()+1).padStart(2, '0') + '-' + String(colomboDate.getDate()).padStart(2, '0');
    log(`Day targets set. Start: $${dayStartCapital.toFixed(2)}, Day target: $${dayTarget.toFixed(2)}, Session target: $${sessionTarget.toFixed(2)}`);
}

function connectWebSocket() {
    ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
    ws.on('open', () => {
        log('WebSocket open. Authorizing...');
        ws.send(JSON.stringify({ authorize: ACCOUNT_TOKEN }));
    });
        // --- Countdown utility ---
        function countdown(seconds, message, cb) {
            let remaining = seconds;
            const barLength = 30;
            function tick() {
                const filled = Math.round(((seconds - remaining) / seconds) * barLength);
                const bar = '[' + '='.repeat(filled) + ' '.repeat(barLength - filled) + ']';
                process.stdout.write(`\r${message} ${remaining}s ${bar}`);
                if (remaining <= 0) {
                    process.stdout.write('\n');
                    if (cb) cb();
                    return;
                }
                remaining--;
                setTimeout(tick, 1000);
            }
            tick();
        }
    ws.on('message', handleMessage);
    ws.on('close', () => {
        log('WebSocket closed. Reconnecting in 5s...');
        setTimeout(connectWebSocket, 5000);
    });
    ws.on('error', err => {
        log('WebSocket error: ' + err.message);
    });
}

function handleMessage(msg) {
    let data = JSON.parse(msg);
    if (data.error) {
        log('API error: ' + data.error.message);
        log('Pausing bot for the rest of the day due to API error. Will attempt to restart at 7:00 AM next day.');
        pausedForDay = true;
        setTimeout(runTradingLoop, 5*60*1000);
        return;
    }
    if (data.msg_type === 'authorize') {
        log('Authorized. Fetching balance...');
        ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
    } else if (data.msg_type === 'balance') {
        capital = data.balance.balance;
        updatedBalance = capital;
        resetDayTargets();
        initialAmountPerTrade = Number((capital * (INITIAL_STAKE_PERCENT/100)).toFixed(2));
        stake = initialAmountPerTrade;
        log(`Balance: $${capital}`);
        runTradingLoop();
    } else if (data.msg_type === 'history') {
        processTickHistory(data);
    } else if (data.msg_type === 'proposal') {
        makeTrade(data);
    } else if (data.msg_type === 'buy') {
        handleBuy(data);
    } else if (data.msg_type === 'proposal_open_contract') {
        handleContractResult(data);
    }
}

function runTradingLoop() {
    // refresh state from disk (dashboard control & auto-pause)
    readBotStateFromFile();

    // If dashboard/user manually paused, and it's not an autoPause, respect it
    if (botState.status === 'paused' && !botState.autoPause) {
        log('Bot paused by dashboard. Sleeping...');
        setTimeout(runTradingLoop, 2000);
        return;
    }

    // If bot is in autoPause (30-minute break), check expiry
    if (botState.autoPause && botState.autoPauseUntil) {
        const nowTs = Date.now();
        if (nowTs < botState.autoPauseUntil) {
            // keep showing waiting/progress fields so dashboard displays properly
            botState.waitingUntil = botState.autoPauseUntil;
            botState.waitingTimeLeft = Math.ceil((botState.waitingUntil - nowTs) / 1000);
            botState.waitingTotal = botState.waitingTotal || Math.ceil((botState.waitingUntil - nowTs) / 1000);
            writeBotStateToFile();
            setTimeout(runTradingLoop, 1000);
            return;
        } else {
            // autoPause expired — clear and resume
            botState.autoPause = false;
            botState.autoPauseUntil = null;
            botState.waitingUntil = null;
            botState.waitingTimeLeft = 0;
            botState.waitingTotal = 0;
            // reset day targets (new reference point)
            resetDayTargets();
            // only resume if dashboard/user didn't explicitly pause
            botState.status = 'running';
            writeBotStateToFile();
            log('Auto pause finished — resuming trading.');
        }
    }

    // If waiting, update botState.waitingUntil for dashboard progress bar
    if (botState.waitingUntil && Date.now() < botState.waitingUntil) {
        botState.waitingTimeLeft = Math.ceil((botState.waitingUntil - Date.now()) / 1000);
        // Console progress bar
        const total = Math.ceil((botState.waitingUntil - (botState.waitingUntil - botState.waitingTimeLeft * 1000)) / 1000);
        const elapsed = total - botState.waitingTimeLeft;
        const barLength = 30;
        const filled = Math.round((elapsed / total) * barLength);
        const bar = '[' + '='.repeat(filled) + ' '.repeat(barLength - filled) + ']';
        process.stdout.write(`\rWaiting ${botState.waitingTimeLeft}s ${bar}`);
        if (botState.waitingTimeLeft === 0) process.stdout.write('\n');
        writeBotStateToFile();
        setTimeout(runTradingLoop, 1000);
        return;
    } else {
        botState.waitingUntil = null;
        botState.waitingTimeLeft = 0;
    }
    const now = new Date();
    const nowDay = now.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }).slice(0,10);
    const nowHour = getColomboHour(now);
    // Auto-reset targets at 7:00 AM and 3:00 PM Sri Lanka time
    if ((nowHour === 7 || nowHour === 15) && (!pausedForDay || nowDay !== lastDay)) {
        log(`Auto-reset: Starting new session at ${nowHour}:00 Sri Lanka time.`);
        pausedForDay = false;
        resetDayTargets();
    }
    if (pausedForDay) {
        // Only resume at 7:00 AM Sri Lanka time
        if (nowHour >= resumeHour && nowDay !== lastDay) {
            log('7:00 AM reached and new day detected. Resetting day targets and resuming trading.');
            pausedForDay = false;
            resetDayTargets();
        } else {
            log(`Day target reached. Bot will resume at 7:00 AM. Current time: ${now.toLocaleTimeString('en-US', { timeZone: 'Asia/Colombo' })}`);
            setTimeout(runTradingLoop, 5*60*1000);
            return;
        }
    }
    if (lastDay && nowDay !== lastDay && nowHour >= resumeHour) {
        log('New day and after 7:00 AM. Resetting day targets.');
        resetDayTargets();
    }
    // Only pause for the day (full day pause) if after 18:00
    if ((updatedBalance - dayStartCapital >= dayTarget) && !isWaitingForRecovery && currentLoss >= 0) {
        if (nowHour >= 18) {
            log('Day target reached and it is after 18:00. Bot will pause until 7:00 AM next day.');
            pausedForDay = true;
            setTimeout(runTradingLoop, 5*60*1000);
            return;
        }
        // otherwise, let the trade/result handler manage auto-pauses (30min cycles)
    }
    if (isWaitingForRecovery) {
        log('Waiting for recovery trigger digit...');
        requestTickHistory();
        return;
    }
    requestTickHistory();
}

function requestTickHistory() {
    ws.send(JSON.stringify({
        ticks_history: market,
        end: 'latest',
        count: 1000,
        style: 'ticks'
    }));
}

function processTickHistory(data) {
    const digits = data.history.prices.map(p => Number(String(p).slice(-1)));
    const over2Count = digits.filter(d => d > DIGIT).length;
    const probability = (over2Count / digits.length) * 100;
    const lastDigits = digits.slice(-5);
    const lastDigit = digits[digits.length-1];
    log(`Tick history: Prob >${DIGIT}: ${probability.toFixed(2)}%, Last 5: ${lastDigits.join(',')}, Last: ${lastDigit}`);
    if (tradeActive) {
        log('Trade already active. Waiting for result before opening a new trade.');
            countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next trade in', runTradingLoop);
        return;
    }
    if (isWaitingForRecovery) {
        if (RECOVERY_TRIGGER_DIGITS.includes(lastDigit)) {
            log(`Recovery trigger digit ${lastDigit} found. Placing recovery trade with stake $${recoveryStake}`);
            isWaitingForRecovery = false;
            tradeActive = true;
            placeTrade(recoveryStake);
        } else {
                countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next recovery check in', runTradingLoop);
        }
        return;
    }
    if (probability >= 70) {
        if (lostCountInRow >= 1) {
            const criticalDigits = RECOVERY_TRIGGER_DIGITS;
            const count = lastDigits.filter(d => criticalDigits.includes(d)).length;
            if (count >= 1) {
                log('Consecutive losses and critical digits found. Placing trade.');
                tradeActive = true;
                placeTrade(stake);
            } else {
                log('Waiting for better digits after loss.');
                    countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next trade in', runTradingLoop);
            }
        } else {
            log('Condition met. Placing Over 2 trade.');
            tradeActive = true;
            placeTrade(stake);
        }
    } else {
        log('Skipped trade. Probability too low.');
            countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next trade in', runTradingLoop);
    }
}

function placeTrade(stakeAmount) {
    stakeAmount = Math.max(0.35, Number(stakeAmount.toFixed(2)));
    let tradeRequest = {
        proposal: 1,
        amount: stakeAmount.toFixed(2),
        basis: 'stake',
        contract_type: 'DIGITOVER',
        currency: 'USD',
        duration: TICK_DURATION,
        duration_unit: 't',
        symbol: market,
        barrier: DIGIT
    };
    ws.send(JSON.stringify(tradeRequest));
}

function makeTrade(proposal) {
    if (!proposal.proposal || !proposal.proposal.id) {
        log('Invalid trade proposal.');
        setTimeout(runTradingLoop, TRADE_INTERVAL_MS);
        return;
    }
    ws.send(JSON.stringify({
        buy: proposal.proposal.id,
        price: proposal.proposal.ask_price
    }));
}

function handleBuy(data) {
    if (!data.buy || !data.buy.contract_id) {
        log('Trade buy failed.');
        setTimeout(runTradingLoop, TRADE_INTERVAL_MS);
        return;
    }
    log(`Trade placed. Contract ID: ${data.buy.contract_id}, Price: $${data.buy.buy_price}`);
    setTimeout(() => {
        ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: data.buy.contract_id }));
    }, 1000);
}

function handleContractResult(data) {
    const contract = data.proposal_open_contract;
    tradeActive = false; // Mark trade as closed
    if (!contract || contract.is_expired !== 1) {
        setTimeout(() => {
            ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contract.contract_id }));
        }, 1000);
        return;
    }
    const profit = contract.profit;
    updatedBalance += profit;
    currentProfit += profit;
    currentLoss += profit;
    if (currentLoss >= 0) currentLoss = 0;
    const tradeTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
    log(`Trade result: ${profit > 0 ? 'WIN' : 'LOSS'} | Profit: $${profit.toFixed(2)} | Balance: $${updatedBalance.toFixed(2)} | Trade time: ${tradeTime}`);
    if (profit > 0) {
        lostCountInRow = 0;
        stake = initialAmountPerTrade;
        if (updatedBalance - dayStartCapital >= dayTarget) {
            const nowHour = getColomboHour(new Date());
            // If before 18:00, take an automated 30-minute pause then resume; repeat until 18:00
            if (nowHour < 18) {
                const pauseMs = 30 * 60 * 1000; // 30 minutes
                const until = Date.now() + pauseMs;
                // mark auto-pause in state so dashboard shows countdown and we can persist across restarts
                botState.autoPause = true;
                botState.autoPauseUntil = until;
                // reflect as waiting so UI/progress bar can reuse waiting fields
                botState.waitingUntil = until;
                botState.waitingTimeLeft = Math.ceil(pauseMs/1000);
                botState.waitingTotal = Math.ceil(pauseMs/1000);
                // set status to paused (but note this is an automated pause)
                botState.status = 'paused';
                writeBotStateToFile();
                log('Day target reached. Auto-pausing for 30 minutes (will resume automatically until 18:00).');
                // schedule a resume check (non-critical; runTradingLoop will also clear when time passes)
                setTimeout(() => {
                    readBotStateFromFile();
                    const now = Date.now();
                    if (botState.autoPause && botState.autoPauseUntil && botState.autoPauseUntil <= now) {
                        // clear auto-pause and resume
                        botState.autoPause = false;
                        botState.autoPauseUntil = null;
                        botState.waitingUntil = null;
                        botState.waitingTimeLeft = 0;
                        botState.waitingTotal = 0;
                        // reset day targets so next 10% is relative to new balance
                        resetDayTargets();
                        // only auto-resume if the dashboard/user hasn't manually paused
                        botState.status = 'running';
                        writeBotStateToFile();
                        log('Auto-pause ended. Resuming trading.');
                        runTradingLoop();
                    }
                }, pauseMs + 1000);
                return;
            } else {
                // After 18:00, pause the bot for the rest of day
                log('Day target achieved after 18:00. Bot will pause until next calendar day.');
                pausedForDay = true;
                writeBotStateToFile();
                setTimeout(runTradingLoop, 5*60*1000);
                return;
            }
        }
        countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next trade in', runTradingLoop);
    } else {
        lostCountInRow++;
        if (lostCountInRow >= 3) {
            recoveryStake = calcStake('Recovery', currentLoss);
            isWaitingForRecovery = true;
            log('3 consecutive losses. Entering recovery mode.');
                countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next recovery check in', runTradingLoop);
        } else if (lostCountInRow >= 2) {
            recoveryStake = calcStake('Recovery', currentLoss);
            isWaitingForRecovery = true;
            log('2 consecutive losses. Entering recovery monitoring.');
                countdown(Math.floor(TRADE_INTERVAL_MS/1000), 'Next recovery check in', runTradingLoop);
        } else {
            stake = calcStake('Loss');
            market = getRandomMarket(market);
            // Random wait 30-120s after a loss
            const waitSec = Math.floor(Math.random() * (120 - 30 + 1)) + 30;
            botState.waitingUntil = Date.now() + waitSec * 1000;
            botState.waitingTimeLeft = waitSec;
            log(`Trade lost. Waiting ${waitSec}s before next trade. Changing market to ${market}. Next stake: $${stake}`);
            writeBotStateToFile();
                countdown(waitSec, 'Next trade in', runTradingLoop);
        }
    }
}

// --- Start Bot ---
connectWebSocket();
