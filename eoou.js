"use strict";

const WebSocket = require("ws");
const https = require("https");
const { createObjectCsvWriter } = require("csv-writer");
require("dotenv").config();

const APP_ID = process.env.DERIV_APP_ID;
const TOKEN = process.env.DERIV_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!APP_ID || !TOKEN) {
    console.error("Missing DERIV_APP_ID or DERIV_TOKEN in environment.");
    process.exit(1);
}

const MARKETS = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const EMA_PERIOD = 10;
const HISTORY_COUNT = 150;
const BACKTEST_COUNT = 50;
const MAX_LOST_IN_ROW = 4;
const START_STAKE_PERCENT = 0.0035;

const csvWriter = createObjectCsvWriter({
    path: "trades.csv",
    append: true,
    header: [
        { id: "timestamp", title: "timestamp" },
        { id: "symbol", title: "symbol" },
        { id: "mode", title: "mode" },
        { id: "stake", title: "stake" },
        { id: "result", title: "result" },
        { id: "profit", title: "profit" },
        { id: "lostInRow", title: "lostInRow" },
        { id: "totalLostAmount", title: "totalLostAmount" },
        { id: "balance", title: "balance" }
    ]
});

let ws;
let isConnected = false;
let isConnecting = false;
let shouldReconnect = true;
let requestId = 1;
const pendingRequests = new Map();
const tickSubscriptions = new Map();
const contractSubscriptions = new Map();
let pingIntervalId = null;
let lastMessageAt = Date.now();
let watchdogIntervalId = null;
let isAuthorized = false;

let isTradeOpen = false;
let mode = "EO";
let lostInRow = 0;
let totalLostAmount = 0;
let dailyStartBalance = 0;
let currentBalance = 0;
let lastStake = 0;

function timestamp() {
    return new Date().toISOString();
}

function log(message) {
    console.log(`[${timestamp()}] ${message}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return Promise.resolve();
    const payload = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message });
    const options = {
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            res.on("data", () => undefined);
            res.on("end", resolve);
        });
        req.on("error", (error) => {
            log(`Telegram error: ${error.message}`);
            resolve();
        });
        req.write(payload);
        req.end();
    });
}

async function connectWebSocket() {
    if (isConnected) return ws;
    if (isConnecting) {
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (isConnected) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
        return ws;
    }

    isConnecting = true;
    ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.on("open", () => {
        isConnected = true;
        isConnecting = false;
        isAuthorized = false;
        log("WebSocket connected.");
        if (pingIntervalId) clearInterval(pingIntervalId);
        pingIntervalId = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.ping();
                } catch (error) {
                    log(`Ping error: ${error.message}`);
                }
            }
        }, 50000);
        if (watchdogIntervalId) clearInterval(watchdogIntervalId);
        watchdogIntervalId = setInterval(() => {
            const idleMs = Date.now() - lastMessageAt;
            if (idleMs > 70000 && ws && ws.readyState === WebSocket.OPEN) {
                log("No messages for 70s. Forcing reconnect.");
                ws.terminate();
            }
        }, 15000);
    });

    ws.on("message", (data) => {
        lastMessageAt = Date.now();
        const message = JSON.parse(data.toString());
        if (message.req_id && pendingRequests.has(message.req_id)) {
            const { resolve, reject, timeoutId } = pendingRequests.get(message.req_id);
            clearTimeout(timeoutId);
            pendingRequests.delete(message.req_id);
            if (message.error) {
                reject(new Error(message.error.message));
            } else {
                resolve(message);
            }
            return;
        }
        if (message.msg_type === "tick" && message.tick) {
            const subId = message.tick.id;
            const handler = tickSubscriptions.get(subId);
            if (handler) handler(message.tick);
            return;
        }
        if (message.msg_type === "proposal_open_contract" && message.proposal_open_contract) {
            const subId = message.proposal_open_contract.id;
            const handler = contractSubscriptions.get(subId);
            if (handler) handler(message.proposal_open_contract);
        }
    });

    ws.on("close", () => {
        isConnected = false;
        isConnecting = false;
        isAuthorized = false;
        log("WebSocket disconnected.");
        if (pingIntervalId) {
            clearInterval(pingIntervalId);
            pingIntervalId = null;
        }
        if (watchdogIntervalId) {
            clearInterval(watchdogIntervalId);
            watchdogIntervalId = null;
        }
        for (const { reject, timeoutId } of pendingRequests.values()) {
            clearTimeout(timeoutId);
            reject(new Error("WebSocket disconnected"));
        }
        pendingRequests.clear();
        tickSubscriptions.clear();
        contractSubscriptions.clear();
        if (shouldReconnect) {
            setTimeout(() => connectWebSocket(), 1000);
        }
    });

    ws.on("error", (err) => {
        log(`WebSocket error: ${err.message}`);
    });

    await new Promise((resolve) => {
        const interval = setInterval(() => {
            if (isConnected) {
                clearInterval(interval);
                resolve();
            }
        }, 50);
    });

    return ws;
}

async function sendRequest(payload, attempts = 2) {
    try {
        await connectWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not ready");
        }
        if (!isAuthorized && !payload.authorize) {
            await authorize();
        }
        const reqId = requestId++;
        const message = { ...payload, req_id: reqId };
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingRequests.delete(reqId);
                reject(new Error("Request timeout"));
            }, 15000);
            pendingRequests.set(reqId, { resolve, reject, timeoutId });
            ws.send(JSON.stringify(message));
        });
    } catch (error) {
        const isRetryable = /timeout|disconnected|not ready|please log in/i.test(error.message);
        if (attempts > 0 && isRetryable) {
            log(`Request failed (${error.message}). Reconnecting...`);
            try {
                if (ws && ws.readyState === WebSocket.OPEN) ws.terminate();
            } catch (terminateError) {
                log(`Terminate error: ${terminateError.message}`);
            }
            await sleep(1000);
            return sendRequest(payload, attempts - 1);
        }
        throw error;
    }
}

async function authorize() {
    const response = await sendRequest({ authorize: TOKEN });
    log("Authorized.");
    isAuthorized = true;
    return response.authorize;
}

async function getBalance() {
    const response = await sendRequest({ balance: 1, subscribe: 0 });
    return response.balance.balance;
}

async function subscribeTicks(symbol, onTick) {
    const response = await sendRequest({ ticks: symbol, subscribe: 1 });
    const subId = response.tick.id;
    tickSubscriptions.set(subId, onTick);
    return subId;
}

async function forgetSubscription(id) {
    if (!id) return;
    try {
        await sendRequest({ forget: id });
    } catch (error) {
        log(`Forget failed: ${error.message}`);
    }
}

function normalizePrice(price) {
    return Number(price).toFixed(4);
}

function getLastDigit(price) {
    const normalized = normalizePrice(price);
    return parseInt(normalized.slice(-1), 10);
}

function calculateEMA(values, period = EMA_PERIOD) {
    const alpha = 2 / (period + 1);
    let ema = values[0] ?? 0;
    for (let i = 1; i < values.length; i += 1) {
        ema = alpha * values[i] + (1 - alpha) * ema;
    }
    return ema;
}

function analyzeEOMarket(digits) {
    const smoothed = Array.from({ length: 10 }, (_, digit) => {
        const series = digits.map((value) => (value === digit ? 1 : 0));
        return calculateEMA(series);
    });
    const evenScore = smoothed[0] + smoothed[2] + smoothed[4] + smoothed[6] + smoothed[8];
    const oddScore = smoothed[1] + smoothed[3] + smoothed[5] + smoothed[7] + smoothed[9];
    return { evenScore, oddScore, smoothed };
}

function analyzeOUMarket(digits) {
    const smoothed = Array.from({ length: 10 }, (_, digit) => {
        const series = digits.map((value) => (value === digit ? 1 : 0));
        return calculateEMA(series);
    });
    const lowDigitScore = smoothed[0] + smoothed[1] + smoothed[2];
    const lowDigitPercent = lowDigitScore * 100;
    return { lowDigitScore, lowDigitPercent, smoothed };
}

function backtestDurations(digits, direction) {
    let bestDuration = 1;
    let bestWinRate = -1;
    for (let duration = 1; duration <= 10; duration += 1) {
        let wins = 0;
        let trials = 0;
        for (let i = 0; i + duration < digits.length; i += 1) {
            const targetDigit = digits[i + duration];
            const isEven = targetDigit % 2 === 0;
            const predictedEven = direction === "DIGITEVEN";
            if (isEven === predictedEven) wins += 1;
            trials += 1;
        }
        const winRate = trials > 0 ? wins / trials : 0;
        if (winRate > bestWinRate) {
            bestWinRate = winRate;
            bestDuration = duration;
        }
    }
    return bestDuration;
}

async function getTickDigits(symbol, count) {
    const response = await sendRequest({
        ticks_history: symbol,
        end: "latest",
        count,
        style: "ticks"
    });
    return response.history.prices.map(getLastDigit);
}

async function selectBestEOMarket() {
    let best = null;
    for (const symbol of MARKETS) {
        const digits = await getTickDigits(symbol, HISTORY_COUNT);
        const analysis = analyzeEOMarket(digits);
        const imbalance = Math.abs(analysis.evenScore - analysis.oddScore);
        if (!best || imbalance > best.imbalance) {
            const direction = analysis.evenScore > analysis.oddScore ? "DIGITEVEN" : "DIGITODD";
            const duration = backtestDurations(digits.slice(-BACKTEST_COUNT), direction);
            best = { symbol, digits, analysis, imbalance, direction, duration };
        }
    }
    return best;
}

async function selectBestOUMarket() {
    const eligible = [];
    for (const symbol of MARKETS) {
        const digits = await getTickDigits(symbol, HISTORY_COUNT);
        const analysis = analyzeOUMarket(digits);
        if (analysis.lowDigitPercent <= 9) {
            eligible.push({ symbol, digits, analysis });
        }
    }
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => a.analysis.lowDigitPercent - b.analysis.lowDigitPercent);
    return eligible[0];
}

async function createProposal(symbol, contractType, duration, stake, barrier) {
    const payload = {
        proposal: 1,
        amount: Number(stake.toFixed(2)),
        basis: "stake",
        contract_type: contractType,
        currency: "USD",
        duration,
        duration_unit: "t",
        symbol
    };
    if (barrier !== undefined) payload.barrier = barrier;
    const response = await sendRequest(payload);
    return response.proposal;
}

async function placeTrade(proposal) {
    const response = await sendRequest({ buy: proposal.id, price: proposal.ask_price });
    return response.buy.contract_id;
}

async function monitorContract(contractId) {
    const response = await sendRequest({ proposal_open_contract: 1, subscribe: 1, contract_id: contractId });
    const subId = response.proposal_open_contract.id;
    return new Promise((resolve, reject) => {
        contractSubscriptions.set(subId, (contract) => {
            if (contract.is_sold) {
                contractSubscriptions.delete(subId);
                forgetSubscription(subId).catch(() => undefined);
                resolve(contract);
            }
        });
        setTimeout(() => {
            if (contractSubscriptions.has(subId)) {
                contractSubscriptions.delete(subId);
                reject(new Error("Contract monitoring timeout"));
            }
        }, 120000);
    });
}

async function waitForEntry(symbol, predicate) {
    let subId;
    return new Promise(async (resolve, reject) => {
        try {
            subId = await subscribeTicks(symbol, async (tick) => {
                const digit = getLastDigit(tick.quote);
                if (predicate(digit)) {
                    await forgetSubscription(subId);
                    resolve({ digit, tick });
                }
            });
        } catch (error) {
            if (subId) await forgetSubscription(subId);
            reject(error);
        }
    });
}

async function logTrade(record) {
    await csvWriter.writeRecords([record]);
}

function updateDailyPnL() {
    const dailyPnL = currentBalance - dailyStartBalance;
    const lossLimit = -0.08 * dailyStartBalance;
    const profitLimit = 0.1 * dailyStartBalance;
    log(`Daily PnL: ${dailyPnL.toFixed(2)}`);
    if (dailyPnL <= lossLimit) {
        log("Daily stop loss reached. Stopping bot.");
        return false;
    }
    if (dailyPnL >= profitLimit) {
        log("Daily profit target reached. Stopping bot.");
        return false;
    }
    return true;
}

function checkRiskCap() {
    if (totalLostAmount >= currentBalance * 0.1) {
        log(`Risk cap hit. totalLostAmount=${totalLostAmount.toFixed(2)}`);
        return false;
    }
    return true;
}

async function runEOMode() {
    const best = await selectBestEOMarket();
    if (!best) {
        await sleep(5000);
        return;
    }

    log(`Mode: EO | Selected market: ${best.symbol} | Direction: ${best.direction} | Duration: ${best.duration}`);

    const entry = await waitForEntry(best.symbol, (digit) => {
        const isEven = digit % 2 === 0;
        return best.direction === "DIGITEVEN" ? isEven : !isEven;
    });

    log(`Entry digit: ${entry.digit}`);
    lastStake = Math.max(0.35, currentBalance * START_STAKE_PERCENT);

    const proposal = await createProposal(best.symbol, best.direction, best.duration, lastStake);
    const contractId = await placeTrade(proposal);
    isTradeOpen = true;
    const result = await monitorContract(contractId);
    isTradeOpen = false;

    const profit = Number(result.profit);
    currentBalance = await getBalance();

    const outcome = profit >= 0 ? "WIN" : "LOSS";
    log(`EO result: ${outcome} | Profit: ${profit.toFixed(2)} | Balance: ${currentBalance.toFixed(2)}`);

    if (profit >= 0) {
        lostInRow = 0;
        totalLostAmount = 0;
        await logTrade({
            timestamp: timestamp(),
            symbol: best.symbol,
            mode,
            stake: lastStake.toFixed(2),
            result: "WIN",
            profit: profit.toFixed(2),
            lostInRow,
            totalLostAmount: totalLostAmount.toFixed(2),
            balance: currentBalance.toFixed(2)
        });
        await sendTelegramMessage(
            `EO ${best.symbol} ${outcome} | Stake: ${lastStake.toFixed(2)} | Profit: ${profit.toFixed(2)} | Balance: ${currentBalance.toFixed(2)} | lostInRow: ${lostInRow} | totalLost: ${totalLostAmount.toFixed(2)}`
        );
        await sleep(5000);
        return;
    }

    totalLostAmount += lastStake;
    lostInRow += 1;

    await logTrade({
        timestamp: timestamp(),
        symbol: best.symbol,
        mode,
        stake: lastStake.toFixed(2),
        result: "LOSS",
        profit: profit.toFixed(2),
        lostInRow,
        totalLostAmount: totalLostAmount.toFixed(2),
        balance: currentBalance.toFixed(2)
    });
    await sendTelegramMessage(
        `EO ${best.symbol} ${outcome} | Stake: ${lastStake.toFixed(2)} | Profit: ${profit.toFixed(2)} | Balance: ${currentBalance.toFixed(2)} | lostInRow: ${lostInRow} | totalLost: ${totalLostAmount.toFixed(2)}`
    );

    mode = "OU";
    log(`Switching to OU mode | lostInRow: ${lostInRow} | totalLostAmount: ${totalLostAmount.toFixed(2)}`);
}

async function runOUMode() {
    const best = await selectBestOUMarket();
    if (!best) {
        log("No OU-eligible markets found. Retrying soon.");
        await sleep(5000);
        return;
    }

    log(`Mode: OU | Selected market: ${best.symbol}`);

    const entry = await waitForEntry(best.symbol, (digit) => [0, 1, 2].includes(digit));
    log(`Entry digit: ${entry.digit}`);

    lastStake = Math.max(0.35, totalLostAmount * 3);
    const proposal = await createProposal(best.symbol, "DIGITOVER", 1, lastStake, "2");
    const contractId = await placeTrade(proposal);
    isTradeOpen = true;
    const result = await monitorContract(contractId);
    isTradeOpen = false;

    const profit = Number(result.profit);
    currentBalance = await getBalance();

    const outcome = profit >= 0 ? "WIN" : "LOSS";
    log(`OU result: ${outcome} | Profit: ${profit.toFixed(2)} | Balance: ${currentBalance.toFixed(2)}`);

    if (profit >= 0) {
        totalLostAmount = 0;
        lostInRow = 0;
        mode = "EO";
    } else {
        totalLostAmount += lastStake;
        lostInRow += 1;
    }

    await logTrade({
        timestamp: timestamp(),
        symbol: best.symbol,
        mode: "OU",
        stake: lastStake.toFixed(2),
        result: outcome,
        profit: profit.toFixed(2),
        lostInRow,
        totalLostAmount: totalLostAmount.toFixed(2),
        balance: currentBalance.toFixed(2)
    });
    await sendTelegramMessage(
        `OU ${best.symbol} ${outcome} | Stake: ${lastStake.toFixed(2)} | Profit: ${profit.toFixed(2)} | Balance: ${currentBalance.toFixed(2)} | lostInRow: ${lostInRow} | totalLost: ${totalLostAmount.toFixed(2)}`
    );

    log(`lostInRow: ${lostInRow} | totalLostAmount: ${totalLostAmount.toFixed(2)}`);

    if (lostInRow >= MAX_LOST_IN_ROW) {
        log(`Max loss reached. totalLostAmount=${totalLostAmount.toFixed(2)}`);
        log(`Next OU stake would be ${(totalLostAmount * 3).toFixed(2)}`);
        shouldReconnect = false;
        process.exit(0);
    }

    if (lostInRow === 2) {
        await sleep(randomBetween(60, 180) * 1000);
    }
    if (lostInRow === 3) {
        await sleep(randomBetween(300, 600) * 1000);
    }
}

async function main() {
    await connectWebSocket();
    await authorize();
    currentBalance = await getBalance();
    dailyStartBalance = currentBalance;
    log(`Starting balance: ${currentBalance.toFixed(2)}`);

    while (true) {
        if (isTradeOpen) {
            await sleep(1000);
            continue;
        }
        if (!checkRiskCap() || !updateDailyPnL()) {
            shouldReconnect = false;
            process.exit(0);
        }
        if (mode === "EO") {
            await runEOMode();
        } else {
            await runOUMode();
        }
    }
}

main().catch((error) => {
    log(`Fatal error: ${error.message}`);
    process.exit(1);
});
