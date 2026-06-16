// bot.js - Version 3.4 - Complete Timezone Fix
// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ==================== CONFIGURATION FROM .env ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
    console.error('❌ FATAL ERROR: BOT_TOKEN not found in .env file!');
    process.exit(1);
}

const app = express();
const employees = {};

app.get('/', (req, res) => res.send('Employee Attendance Bot is running!'));
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        employees: Object.keys(employees).length,
        version: '3.4'
    });
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==================== TIMEZONE CONFIGURATION ====================
const MEXICO_TIMEZONE = 'America/Mexico_City';
const WORK_START_HOUR = 8;
const WORK_START_MINUTE = 0;
const LATE_THRESHOLD_MINUTES = 15;
const ACTIVITY_TIMEOUT = 15 * 60 * 1000;

let reminderInterval = null;
let lateCheckInterval = null;
let keepAliveInterval = null;

const ACTIVITIES = {
    '吃饭': { type: 'meal', name: 'Meal Time' },
    '抽烟': { type: 'smoke', name: 'Smoke Break' },
    '厕所': { type: 'restroom', name: 'Restroom' },
    '下楼拿外卖': { type: 'delivery', name: 'Delivery' }
};

// ==================== CRITICAL FIX: Mexico Time Helper Functions ====================

/**
 * Get current time in Mexico as a Date object
 */
function getMexicoDate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE }));
}

/**
 * CRITICAL FIX: Get the target work start time for TODAY in Mexico timezone
 * Returns a Date object that correctly represents 8:00 AM Mexico time today
 */
function getTodayWorkStartMexico() {
    const mexicoNow = getMexicoDate();
    const workStart = new Date(mexicoNow);
    workStart.setHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);
    return workStart;
}

/**
 * CRITICAL FIX: Check if a clock-in time is late
 * This compares the Mexico timezone hour/minute of the clock-in vs work start
 */
function isUserLate(startTimestamp) {
    if (!startTimestamp) return false;
    
    // Get the Mexico timezone hour and minute from the stored timestamp
    const startDate = new Date(startTimestamp);
    const startMexicoStr = startDate.toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE });
    const startMexicoDate = new Date(startMexicoStr);
    
    const startHour = startMexicoDate.getHours();
    const startMinute = startMexicoDate.getMinutes();
    
    // Calculate minutes after 8:00 AM
    const minutesAfter8 = (startHour - WORK_START_HOUR) * 60 + (startMinute - WORK_START_MINUTE);
    
    // Late if more than 15 minutes after 8:00 AM Mexico time
    return minutesAfter8 > LATE_THRESHOLD_MINUTES;
}

/**
 * CRITICAL FIX: Get how late someone is (in milliseconds)
 */
function getLateDuration(startTimestamp) {
    if (!startTimestamp) return 0;
    
    const startDate = new Date(startTimestamp);
    const startMexicoStr = startDate.toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE });
    const startMexicoDate = new Date(startMexicoStr);
    
    const workStartMexico = getTodayWorkStartMexico();
    
    // Calculate difference in milliseconds
    const lateMs = startMexicoDate.getTime() - workStartMexico.getTime();
    
    return Math.max(0, lateMs);
}

/**
 * Format time in Mexico timezone
 */
function formatMexicoTime(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: false,
        timeZone: MEXICO_TIMEZONE
    });
}

/**
 * Format duration as HH:MM:SS
 */
function formatDurationAsHMS(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDurationWithSeconds(ms) {
    if (!ms || ms < 0) return '0s';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function getLateDurationFormatted(startTimestamp) {
    return formatDurationAsHMS(getLateDuration(startTimestamp));
}

async function sendNotification(message, parseMode = 'Markdown') {
    let sent = false;
    if (GROUP_CHAT_ID) {
        try {
            await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: parseMode });
            sent = true;
        } catch (err) {
            console.error(`Failed to send to group:`, err.message);
        }
    }
    for (const adminId of ADMIN_IDS) {
        if (adminId && adminId.trim()) {
            try {
                await bot.sendMessage(adminId.trim(), message, { parse_mode: parseMode });
                sent = true;
            } catch (err) {
                if (!err.message.includes('bot can\'t initiate conversation')) {
                    console.error(`Failed to notify admin ${adminId}:`, err.message);
                }
            }
        }
    }
    if (!sent) {
        console.log('📝 Notification:', message.substring(0, 100));
    }
}

function mentionUser(name, telegramId) {
    return `[${name}](tg://user?id=${telegramId})`;
}

async function getUserInfo(msg) {
    if (msg.chat.type === 'channel') {
        const telegramId = 'channel_' + msg.chat.id;
        const name = 'Channel User';
        if (!employees[telegramId]) {
            employees[telegramId] = {
                name: name, telegramId: telegramId, status: 'off',
                workStart: null, workEnd: null, currentActivity: null,
                activityStart: null, reminderSent: false, lateNotified: false,
                currentChatId: msg.chat.id,
                totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
                dailyReport: { workStart: null, workEnd: null, totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 } }
            };
        }
        return { telegramId, name };
    }
    
    const from = msg.from;
    if (!from) throw new Error('Cannot identify user');
    
    const telegramId = from.id.toString();
    const name = from.first_name + (from.last_name ? ' ' + from.last_name : '');
    
    if (!employees[telegramId]) {
        employees[telegramId] = {
            name: name, telegramId: telegramId, status: 'off',
            workStart: null, workEnd: null, currentActivity: null,
            activityStart: null, reminderSent: false, lateNotified: false,
            currentChatId: msg.chat.id,
            totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
            dailyReport: { workStart: null, workEnd: null, totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 } }
        };
    } else {
        employees[telegramId].currentChatId = msg.chat.id;
    }
    
    return { telegramId, name };
}

function checkActivityTimeouts() {
    const now = Date.now();
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status === 'away' && emp.currentActivity && emp.activityStart && !emp.reminderSent) {
            const duration = now - emp.activityStart;
            if (duration >= ACTIVITY_TIMEOUT) {
                let activityDisplay = '';
                for (const [key, config] of Object.entries(ACTIVITIES)) {
                    if (config.type === emp.currentActivity) {
                        activityDisplay = config.name;
                        break;
                    }
                }
                const durationFormatted = formatDurationWithSeconds(duration);
                const userMention = mentionUser(emp.name, telegramId);
                const reminderMessage = `⚠️ ACTIVITY REMINDER\n\n${userMention} has been on ${activityDisplay} for over 15 minutes!\n\n⏱️ Duration: ${durationFormatted}\n\nPlease click 返回 (Back) to continue working.`;
                bot.sendMessage(emp.currentChatId || telegramId, reminderMessage, { parse_mode: 'Markdown' }).catch(() => {});
                sendNotification(`⚠️ Activity Alert\n\n${userMention} has been on ${activityDisplay} for ${durationFormatted}`, 'Markdown');
                emp.reminderSent = true;
            }
        }
    }
}

function checkLateArrivals() {
    const mexicoNow = getMexicoDate();
    const currentHour = mexicoNow.getHours();
    
    // Only check between 8:00 AM and 12:00 PM Mexico time
    if (currentHour < 8 || currentHour > 12) return;
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status !== 'off' && emp.workStart && !emp.lateNotified) {
            if (isUserLate(emp.workStart)) {
                const lateDurationText = formatDurationWithSeconds(getLateDuration(emp.workStart));
                const userMention = mentionUser(emp.name, telegramId);
                sendNotification(`⚠️ LATE ARRIVAL\n\n${userMention} started work late!\n⏱️ Late by: ${lateDurationText}`, 'Markdown');
                emp.lateNotified = true;
                console.log(`[LATE] ${emp.name} - ${lateDurationText}`);
            }
        }
    }
}

function startKeepAlive() {
    keepAliveInterval = setInterval(() => {
        console.log(`💓 Keep-alive ping at ${new Date().toISOString()}`);
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 14 * 60 * 1000);
}

function startReminderSystems() {
    if (reminderInterval) clearInterval(reminderInterval);
    reminderInterval = setInterval(() => checkActivityTimeouts(), 60 * 1000);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    lateCheckInterval = setInterval(() => checkLateArrivals(), 60 * 1000);
}

const mainKeyboard = {
    reply_markup: {
        keyboard: [['上班', '下班'], ['吃饭', '抽烟'], ['厕所', '下楼拿外卖'], ['返回']],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// ==================== COMMAND HANDLERS ====================

bot.onText(/\/help/, async (msg) => {
    const helpMessage = `*Bot Usage Guide*

Work Hours: 8:00 AM Mexico Time
Late Threshold: 15 minutes
Activity Limit: 15 minutes

*Commands:*
/start - Welcome message
/status - View employee status
/report - View daily report
/mytime - Check Mexico time
/help - Show this message

*Buttons:*
上班 - Start work
下班 - Finish work
吃饭, 抽烟, 厕所, 下楼拿外卖 - Take breaks
返回 - Return from break`;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type === 'channel') {
        bot.sendMessage(chatId, 'Please add me to a GROUP for tracking.');
        return;
    }
    try {
        const { name, telegramId } = await getUserInfo(msg);
        employees[telegramId].currentChatId = chatId;
        const welcomeMessage = `Welcome ${name}!\n\nWork Hours: 8:00 AM Mexico Time\nActivity Limit: 15 minutes\n\nUse the buttons below to track your work.`;
        bot.sendMessage(chatId, welcomeMessage, mainKeyboard);
        sendNotification(`User Active\n\n${mentionUser(name, telegramId)} started using the bot.`, 'Markdown');
    } catch (error) {
        bot.sendMessage(chatId, '❌ Error identifying user.');
    }
});

bot.onText(/\/mytime/, async (msg) => {
    const mexicoTime = getMexicoDate();
    const workStartTime = getTodayWorkStartMexico();
    const timeMessage = `*Current Mexico Time*\n\n📅 Date: ${mexicoTime.toLocaleDateString('zh-CN')}\n⏱️ Time: ${formatMexicoTime(mexicoTime.getTime())}\n\n🏢 Work Start: ${formatMexicoTime(workStartTime.getTime())}\n⏰ Late After: 8:15 AM`;
    bot.sendMessage(msg.chat.id, timeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const working = [];
    const away = [];
    const late = [];
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        if (emp.status === 'working') {
            let workingText = `${emp.name}`;
            if (isUserLate(emp.workStart)) {
                workingText += ` (Late by ${getLateDurationFormatted(emp.workStart)})`;
                late.push(emp.name);
            }
            working.push(workingText);
        } else if (emp.status === 'away') {
            let activityDisplay = '';
            for (const [key, config] of Object.entries(ACTIVITIES)) {
                if (config.type === emp.currentActivity) {
                    activityDisplay = config.name;
                    break;
                }
            }
            const duration = emp.activityStart ? Date.now() - emp.activityStart : 0;
            away.push(`${emp.name} - ${activityDisplay} (${formatDurationWithSeconds(duration)})`);
        }
    }
    
    let statusMessage = '*Employee Status*\n\n';
    statusMessage += '🟢 WORKING\n';
    statusMessage += working.length > 0 ? working.join('\n') : 'None\n';
    if (late.length > 0) statusMessage += `\n⚠️ Late Arrivals: ${late.length}\n`;
    statusMessage += '\n🟡 AWAY\n';
    statusMessage += away.length > 0 ? away.join('\n') : 'None';
    
    bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    if (Object.keys(employees).length === 0) {
        bot.sendMessage(chatId, 'No employee data available yet.');
        return;
    }
    
    let reportMessage = '*Daily Work Report*\n\n';
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        const workStart = emp.dailyReport.workStart || emp.workStart;
        const workEnd = emp.dailyReport.workEnd || emp.workEnd;
        const totals = emp.dailyReport.totals || emp.totals;
        
        let totalWorkMs = 0;
        if (workStart && workEnd) {
            totalWorkMs = workEnd - workStart;
            totalWorkMs -= (totals.meal + totals.smoke + totals.restroom + totals.delivery);
        }
        
        reportMessage += `*${emp.name}*\n`;
        reportMessage += `Start: ${formatMexicoTime(workStart)}\n`;
        reportMessage += `Finish: ${formatMexicoTime(workEnd)}\n`;
        if (isUserLate(workStart)) reportMessage += `⚠️ Late by: ${getLateDurationFormatted(workStart)}\n`;
        reportMessage += `\n*Breakdown:*\n`;
        reportMessage += `🍚 Meal: ${formatDurationWithSeconds(totals.meal)}\n`;
        reportMessage += `🚬 Smoke: ${formatDurationWithSeconds(totals.smoke)}\n`;
        reportMessage += `🚽 Restroom: ${formatDurationWithSeconds(totals.restroom)}\n`;
        reportMessage += `📦 Delivery: ${formatDurationWithSeconds(totals.delivery)}\n`;
        reportMessage += `\n✅ Total Work: ${formatDurationWithSeconds(totalWorkMs)}\n\n`;
    }
    bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
});

// ==================== BUTTON HANDLERS ====================

bot.onText(/上班/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const emp = employees[telegramId];
        emp.currentChatId = chatId;
        
        if (emp.status === 'working') {
            bot.sendMessage(chatId, '❌ You have already started work today!');
            return;
        }
        if (emp.status === 'away') {
            bot.sendMessage(chatId, '❌ Please finish your current activity (click 返回) before starting work.');
            return;
        }
        
        const now = Date.now();
        emp.status = 'working';
        emp.workStart = now;
        emp.workEnd = null;
        emp.currentActivity = null;
        emp.activityStart = null;
        emp.reminderSent = false;
        emp.lateNotified = false;
        emp.totals = { meal: 0, smoke: 0, restroom: 0, delivery: 0 };
        emp.dailyReport = { workStart: now, workEnd: null, totals: { ...emp.totals } };
        
        const late = isUserLate(now);
        const actualTimeFormatted = formatMexicoTime(now);
        
        let response = `✅ ${name} started work\n⏱️ ${actualTimeFormatted}`;
        
        if (late) {
            const lateDurationText = formatDurationWithSeconds(getLateDuration(now));
            response += `\n\n⚠️ You are late!\n⏱️ Late by: ${lateDurationText}`;
            sendNotification(`⚠️ LATE ARRIVAL\n\n${mentionUser(name, telegramId)} started work at ${actualTimeFormatted}\nLate by: ${lateDurationText}`, 'Markdown');
        } else {
            // Send confirmation that they're on time
            console.log(`[ON TIME] ${name} started at ${actualTimeFormatted}`);
        }
        
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
        console.log(`[LOG] ${name} started at ${actualTimeFormatted} ${late ? '(LATE)' : '(ON TIME)'}`);
    } catch (error) {
        console.error('Error in 上班:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

bot.onText(/下班/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const emp = employees[telegramId];
        
        if (emp.status !== 'working' && emp.status !== 'away') {
            bot.sendMessage(chatId, '❌ You haven\'t started work yet! Please click 上班 first.');
            return;
        }
        
        if (emp.status === 'away') {
            // Auto-return before finishing work
            if (emp.currentActivity && emp.activityStart) {
                const durationMs = Date.now() - emp.activityStart;
                const activityType = emp.currentActivity;
                if (emp.totals[activityType] !== undefined) {
                    emp.totals[activityType] += durationMs;
                    if (emp.dailyReport.totals[activityType] !== undefined) {
                        emp.dailyReport.totals[activityType] += durationMs;
                    }
                }
                emp.status = 'working';
                emp.currentActivity = null;
                emp.activityStart = null;
                emp.reminderSent = false;
            }
        }
        
        const now = Date.now();
        emp.workEnd = now;
        emp.dailyReport.workEnd = now;
        emp.status = 'off';
        
        let workDurationMs = emp.workEnd - emp.workStart;
        const totalBreaks = emp.totals.meal + emp.totals.smoke + emp.totals.restroom + emp.totals.delivery;
        workDurationMs -= totalBreaks;
        
        const response = `✅ ${name} finished work\n\n📊 Work Summary:\n⏱️ Work Duration: ${formatDurationWithSeconds(workDurationMs)}\n⏱️ Break Time: ${formatDurationWithSeconds(totalBreaks)}`;
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (error) {
        console.error('Error in 下班:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

for (const [activityText, config] of Object.entries(ACTIVITIES)) {
    bot.onText(new RegExp(activityText), async (msg) => {
        const chatId = msg.chat.id;
        try {
            const { telegramId, name } = await getUserInfo(msg);
            const emp = employees[telegramId];
            
            if (emp.status !== 'working') {
                bot.sendMessage(chatId, '❌ You must start work first (click 上班) before taking a break.');
                return;
            }
            if (emp.status === 'away') {
                bot.sendMessage(chatId, '❌ You are already on a break. Please click 返回 to continue working.');
                return;
            }
            
            const now = Date.now();
            emp.status = 'away';
            emp.currentActivity = config.type;
            emp.activityStart = now;
            emp.reminderSent = false;
            
            const response = `✅ ${name} started ${config.name}\n⏱️ ${formatMexicoTime(now)}\n⏱️ Time limit: 15 minutes`;
            bot.sendMessage(chatId, response, mainKeyboard);
        } catch (error) {
            console.error(`Error in ${activityText}:`, error);
            bot.sendMessage(chatId, '❌ Error processing request.');
        }
    });
}

bot.onText(/返回/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const emp = employees[telegramId];
        
        if (emp.status !== 'away' || !emp.currentActivity || !emp.activityStart) {
            bot.sendMessage(chatId, '❌ You don\'t have any active activity to return from.');
            return;
        }
        
        const now = Date.now();
        const durationMs = now - emp.activityStart;
        const activityType = emp.currentActivity;
        
        if (emp.totals[activityType] !== undefined) {
            emp.totals[activityType] += durationMs;
            if (emp.dailyReport.totals[activityType] !== undefined) {
                emp.dailyReport.totals[activityType] += durationMs;
            }
        }
        
        let activityDisplay = '';
        for (const [key, config] of Object.entries(ACTIVITIES)) {
            if (config.type === activityType) {
                activityDisplay = config.name;
                break;
            }
        }
        
        emp.status = 'working';
        emp.currentActivity = null;
        emp.activityStart = null;
        emp.reminderSent = false;
        
        const response = `✅ ${name} returned\n\n📊 Activity: ${activityDisplay}\n⏱️ Duration: ${formatDurationWithSeconds(durationMs)}`;
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
    } catch (error) {
        console.error('Error in 返回:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

// ==================== ERROR HANDLING ====================
bot.on('polling_error', (error) => console.error('Polling error:', error.message));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

process.on('SIGTERM', () => {
    if (reminderInterval) clearInterval(reminderInterval);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    server.close(() => process.exit(0));
});

// ==================== STARTUP ====================
console.log('🚀 Starting Employee Attendance Bot v3.4');
console.log('================================================');
console.log(`✅ Timezone: ${MEXICO_TIMEZONE}`);
console.log(`✅ Work start: ${WORK_START_HOUR}:${WORK_START_MINUTE} AM`);
console.log(`✅ Late threshold: ${LATE_THRESHOLD_MINUTES} minutes`);
console.log(`✅ Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'None'}`);
console.log(`✅ Group Chat: ${GROUP_CHAT_ID || 'Not set'}`);

startReminderSystems();
startKeepAlive();

console.log('================================================');
console.log('🎉 Bot is running!');
console.log(`🕐 Current Mexico Time: ${formatMexicoTime(getMexicoDate().getTime())}`);
console.log(`🏢 Work Start (Mexico): ${formatMexicoTime(getTodayWorkStartMexico().getTime())}`);
console.log('================================================');
