// over_under_bot.js
// Node.js version of over_under.js logic (no DOM, uses console)

const WebSocket = require('ws');
require('dotenv').config();

// ============ CONFIGURATION ============
const accounts = [
    { name: "KunkumaGP", value: "lkUxtOopvUhCpIX" },
    { name: "Kunkuma Trading", value: "YbaIy3dD51g2eoO" },
    { name: "W H K G Prasanna 85", value: "iVOpdm24hBhw3JI" },
    { name: "Zion Music 1985", value: "pfn80VW8Lexav5O" },
    { name: "Test Mail", value: "zAhDnvk9VOUB5rD" },
];

const marketArray2 = [
    { value: "R_10", name: "Volatility 10 Index", interval: 2000 },
    { value: "R_50", name: "Volatility 50 Index", interval: 2000 },
];

const overUnderDigitArray = [
    { digit: 0, name: "0", over_payout_percentage: 9, under_payout_percentage: null },
    { digit: 1, name: "1", over_payout_percentage: 23, under_payout_percentage: 793 },
    { digit: 2, name: "2", over_payout_percentage: 40, under_payout_percentage: 372 },
    { digit: 3, name: "3", over_payout_percentage: 63, under_payout_percentage: 221 },
    { digit: 4, name: "4", over_payout_percentage: 95, under_payout_percentage: 143 },
    { digit: 5, name: "5", over_payout_percentage: 143, under_payout_percentage: 95 },
    { digit: 6, name: "6", over_payout_percentage: 221, under_payout_percentage: 63 },
    { digit: 7, name: "7", over_payout_percentage: 372, under_payout_percentage: 40 },
    { digit: 8, name: "8", over_payout_percentage: 793, under_payout_percentage: 23 },
    { digit: 9, name: "9", over_payout_percentage: null, under_payout_percentage: 9 },
];

// ============ BOT STATE ============
let initialAccountBalance = 0,
    updatedAccountBalance = 0,
    stake = 0,
    targetProfitPercentagePerSession = 2,
    amountPercentagePerTrade = 0.35,
    martingaleMultiplier3 = 3,
    dayTargetPercentage = 5,
    marketInterval = 2000,
    selectedOverUnderDigit = overUnderDigitArray.find(item => item.name === "2"),
    market = marketArray2[0].value,
    apiToken = process.env.DERIV_API_TOKEN || accounts[0].value,
    ws,
    isRunning = true,
    isTradeOpen = false,
    lostCountInRow = 0,
    currentProfitAmount = 0,
    currentLossAmount = 0,
    totalTradeCount = 0,
    winTradeCount = 0,
    lossTradeCount = 0,
    lastTradeId = null,
    tradeProposal = null,
    recoveryStake = 0,
    isWaitingForRecoveryTrigger = false;

const SRI_LANKA_OFFSET = 5.5 * 60 * 60 * 1000; // UTC+5:30
let dayStartCapital = 0;
let dayTargetProfit = 0;
let dayTargetBalance = 0;
let tradingStoppedForDay = false;
let pendingDayReset = false;
let hasInitializedDay = false;
let nextStartTimeout = null;

let initialAmountPerTrade = 0;
let targetProfitPerSession = 0;
let waitingForNextTrade = false;

function getRandomMarket(array, current) {
    let randomIndex;
    let randomMarket;
    do {
        randomIndex = Math.floor(Math.random() * array.length);
        randomMarket = array[randomIndex];
    } while (randomMarket.value === current);
    marketInterval = randomMarket.interval;
    return randomMarket.value;
}

function getSriLankaDate() {
    return new Date(Date.now() + SRI_LANKA_OFFSET);
}

function getNext8AM() {
    const now = getSriLankaDate();
    const next8AM = new Date(now);
    next8AM.setHours(8, 0, 0, 0);
    if (now >= next8AM) {
        next8AM.setDate(next8AM.getDate() + 1);
    }
    return next8AM;
}

function isAfter8AM() {
    const now = getSriLankaDate();
    const today8AM = new Date(now);
    today8AM.setHours(8, 0, 0, 0);
    return now >= today8AM;
}

function scheduleStartAtNext8AM() {
    if (nextStartTimeout) return;
    const next8AM = getNext8AM();
    const msUntil8AM = next8AM - getSriLankaDate();
    console.log("Trading paused until 8:00 AM Sri Lanka time.");
    nextStartTimeout = setTimeout(() => {
        nextStartTimeout = null;
        if (!tradingStoppedForDay) {
            runScriptForTrade();
        }
    }, msUntil8AM);
}

function calculateMartingale(lostAmount, selectedOverUnderDigit, type = "over") {
    const payoutPercentage = type === "over" 
        ? selectedOverUnderDigit.over_payout_percentage 
        : selectedOverUnderDigit.under_payout_percentage;
    if (!payoutPercentage || payoutPercentage <= 0) {
        throw new Error("Invalid payout percentage");
    }
    const stake = (lostAmount * 1.5) / (payoutPercentage / 100);
    return Number(stake.toFixed(2));
}

function setAccData(balance) {
    initialAccountBalance = balance;
    updatedAccountBalance = balance;
    currentProfitAmount = 0;
    currentLossAmount = 0;
    targetProfitPerSession = Number((initialAccountBalance * (targetProfitPercentagePerSession / 100)).toFixed(2));
    initialAmountPerTrade = Number((initialAccountBalance * (amountPercentagePerTrade / 100)).toFixed(2));
    if (totalTradeCount === 0) {
        stake = initialAmountPerTrade;
        console.log(`Initial stake: $${stake}`);
    }
    console.log(`Account balance: $${initialAccountBalance}`);
    console.log(`Session target: $${targetProfitPerSession}`);
    // Print updated balance after trade
    if (totalTradeCount > 0) {
        console.log(`Updated Deriv balance: $${initialAccountBalance}`);
    }
    if (!hasInitializedDay || pendingDayReset) {
        initializeDayTargets(initialAccountBalance);
        pendingDayReset = false;
    }
}

function initializeDayTargets(balance) {
    dayStartCapital = balance;
    dayTargetProfit = Number((dayStartCapital * 0.1).toFixed(2));
    dayTargetBalance = Number((dayStartCapital + dayTargetProfit).toFixed(2));
    tradingStoppedForDay = false;
    hasInitializedDay = true;
    console.log(`Day target set: $${dayTargetProfit.toFixed(2)} (10% of $${dayStartCapital.toFixed(2)})`);
    console.log(`Day target balance: $${dayTargetBalance.toFixed(2)}`);
}

function checkDayTarget() {
    if (!dayTargetBalance || dayTargetBalance <= 0) return;
    if (updatedAccountBalance >= dayTargetBalance) {
        tradingStoppedForDay = true;
        console.log(`Day target achieved! Balance: $${updatedAccountBalance.toFixed(2)} / Target: $${dayTargetBalance.toFixed(2)}. Trading stopped until next day.`);
    }
}

function requestBalance(resetDayTarget = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (resetDayTarget) pendingDayReset = true;
    ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
}

function updateCurrentBalance(balance) {
    updatedAccountBalance = balance;
    checkDayTarget();
}

function scheduleNextTrade(delayMs) {
    if (tradingStoppedForDay) return;
    setTimeout(() => {
        if (!tradingStoppedForDay) runScriptForTrade();
    }, delayMs);
}

function startWebSocket() {
    ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");
    ws.onopen = () => {
        console.log("Connection open");
        ws.send(JSON.stringify({ authorize: apiToken }));
    };
    ws.onmessage = (event) => {
        const wsResponse = JSON.parse(event.data);
        if (wsResponse.msg_type === "authorize") {
            setAccData(wsResponse.authorize.balance);
            runScriptForTrade();
        }
        if (wsResponse.msg_type === "balance") {
            if (pendingDayReset) {
                setAccData(wsResponse.balance.balance);
                runScriptForTrade();
                return;
            }
            updateCurrentBalance(wsResponse.balance.balance);
            return;
        }
        if (tradingStoppedForDay && (wsResponse.msg_type === "history" || wsResponse.msg_type === "proposal")) {
            return;
        }
        if (wsResponse.msg_type === "history") {
            const digits = wsResponse.history.prices.map(p => Number(String(p).slice(-1)));
            const over2Count = digits.filter(d => d > 2).length;
            const probability = (over2Count / digits.length) * 100;
            const lastDigits = digits.slice(-5);
            const lastDigit = digits[digits.length - 1];
            if (isWaitingForRecoveryTrigger) {
                if ([0,1,2].includes(lastDigit)) {
                    stake = recoveryStake;
                    market = "R_100";
                    isWaitingForRecoveryTrigger = false;
                    placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                } else {
                    scheduleNextTrade(marketInterval);
                }
                return;
            }
            if (probability >= 70) {
                if (lostCountInRow >= 1) {
                    const criticalDigits = [0,1,2];
                    const count = lastDigits.filter(d => criticalDigits.includes(d)).length;
                    if (count >= 1) {
                        placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                    } else {
                        scheduleNextTrade(marketInterval);
                    }
                } else {
                    placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                }
            } else {
                scheduleNextTrade(marketInterval);
            }
        }
        if (wsResponse.msg_type === "proposal") {
            tradeProposal = wsResponse;
            makeTheTrade(ws);
        }
        if (wsResponse.msg_type === "buy") {
            lastTradeId = wsResponse.buy.contract_id;
            totalTradeCount++;
            isTradeOpen = true;
            setTimeout(() => fetchTradeDetails(ws, lastTradeId), 500);
        }
        if (wsResponse.msg_type === "proposal_open_contract") {
            if (wsResponse.proposal_open_contract.contract_id === lastTradeId) {
                const contract = wsResponse.proposal_open_contract;
                if (contract.is_sold) {
                    const profit = contract.profit;
                    updateDetails(contract, profit);
                    requestBalance();
                    checkDayTarget();
                    if (tradingStoppedForDay) {
                        isTradeOpen = false;
                        return;
                    }
                    stakeChangeForOU(profit > 0 ? "Win" : "Loss");
                    isTradeOpen = false;
                    if (profit < 0) {
                        market = getRandomMarket(marketArray2, market);
                        // Use last lost amount for recovery stake
                        if (lostCountInRow >= 2) {
                            let lastLostAmount = Math.abs(profit); // profit is negative for loss
                            let nextStakeValue = lastLostAmount * martingaleMultiplier3;
                            recoveryStake = nextStakeValue;
                            isWaitingForRecoveryTrigger = true;
                            market = "R_100";
                            scheduleNextTrade(getRandomNumber(180, 300) * 1000);
                        } else {
                            scheduleNextTrade(20000);
                        }
                    } else {
                        lostCountInRow = 0;
                        scheduleNextTrade(10000);
                    }
                } else {
                    setTimeout(() => fetchTradeDetails(ws, lastTradeId), marketInterval);
                }
            }
        }
    };
    ws.onclose = () => {
        console.log("Connection closed");
        if (isRunning) setTimeout(startWebSocket, 1000);
    };
    ws.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

function runScriptForTrade() {
    if (waitingForNextTrade || tradingStoppedForDay) return;
    checkDayTarget();
    if (tradingStoppedForDay) return;
    if (!isAfter8AM()) {
        scheduleStartAtNext8AM();
        return;
    }
    isRunning = true;
    ws.send(JSON.stringify({
        ticks_history: market,
        end: "latest",
        count: 1000,
        style: "ticks"
    }));
}

function makeTheTrade(ws) {
    if (tradingStoppedForDay) {
        console.log("Trading stopped for day. Skipping trade execution.");
        return;
    }
    if (!tradeProposal.proposal || !tradeProposal.proposal.id) {
        isRunning = false;
    } else {
        let buyRequest = {
            buy: tradeProposal.proposal.id,
            price: tradeProposal.proposal.ask_price,
        };
        ws.send(JSON.stringify(buyRequest));
    }
}

function fetchTradeDetails(ws, contractId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId }));
}

function updateDetails(contract, lastTradeProfit) {
    if (lastTradeProfit > 0) {
        winTradeCount++;
        lostCountInRow = 0;
        currentProfitAmount += lastTradeProfit;
    } else {
        lossTradeCount++;
        lostCountInRow++;
        currentLossAmount += lastTradeProfit;
        // Store last lost amount for martingale calculation
        stakeChangeForOU.lastLostAmount = Math.abs(lastTradeProfit);
    }
    // Print trade result; balance will be updated via balance response
    console.log(`Trade result: ${lastTradeProfit > 0 ? 'WIN' : 'LOSS'} | Profit: $${lastTradeProfit.toFixed(2)} | Balance: (fetching...)`);
}

function waitWithCountdown(seconds, callback) {
    waitingForNextTrade = true;
    let remaining = seconds;
    const interval = setInterval(() => {
        if (tradingStoppedForDay) {
            clearInterval(interval);
            waitingForNextTrade = false;
            process.stdout.write('\n');
            return;
        }
        process.stdout.write(`\rWaiting ${remaining}s before next trade...   `);
        remaining--;
        if (remaining <= 0) {
            clearInterval(interval);
            process.stdout.write('\n');
            waitingForNextTrade = false;
            callback();
        }
    }, 1000);
}

function stakeChangeForOU(status) {
    if (status === "Loss") {
        // Use last lost amount for martingale calculation
        if (typeof stakeChangeForOU.lastLostAmount === 'number') {
            stake = stakeChangeForOU.lastLostAmount * martingaleMultiplier3;
        } else {
            stake = stake * martingaleMultiplier3;
        }
        // Wait 10-15 minutes if 3+ losses in a row, else 60-120 seconds
        let waitSeconds;
        if (lostCountInRow >= 3) {
            waitSeconds = getRandomNumber(600, 900);
            console.log(`3 or more losses in a row. Waiting ${waitSeconds}s before next trade.`);
        } else {
            waitSeconds = getRandomNumber(180, 300);
        }
        waitWithCountdown(waitSeconds, () => {
            runScriptForTrade();
        });
        return; // Prevent immediate next trade
    } else if (status === "Win") {
        stake = initialAmountPerTrade;
    }
    stake = Math.max(stake, 0.35);
    console.log(`Next stake: $${stake.toFixed(2)}`);
    if (status === "Win") {
        scheduleNextTrade(10000);
    }
}

function getRandomNumber(min, max) {
    if (min > max) throw new Error("Min value must be less than or equal to Max value");
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function placeOUTrade(market, selectedbarrierNumber = null, initialAccountBalance = null, tickDuration = 1) {
    if (tradingStoppedForDay) {
        console.log("Trading stopped for day. Not placing new trade.");
        return;
    }
    if (!isTradeOpen) {
        let barrierNumber = selectedbarrierNumber !== null ? selectedbarrierNumber.digit : 2;
        stake = Math.max(Number(stake), 0.35);
        let tradeRequest = {
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITOVER',
            currency: 'USD',
            duration: tickDuration,
            duration_unit: 't',
            symbol: market,
            barrier: barrierNumber
        };
        isTradeOpen = true;
        console.log("Sending trade request:", tradeRequest);
        ws.send(JSON.stringify(tradeRequest));
    }
}

// ============ START BOT ============
console.log("Starting Over/Under Bot...");
startWebSocket();

function scheduleDailyReset() {
    const next8AM = getNext8AM();
    const msUntil8AM = next8AM - getSriLankaDate();
    setTimeout(() => {
        requestBalance(true);
        scheduleDailyReset();
    }, msUntil8AM);
}

scheduleDailyReset();
