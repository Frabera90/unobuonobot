require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const cron = require('node-cron')
const db = require('./db')
const ai = require('./ai')

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function typing(chatId, ms = 1500) {
  await bot.sendChatAction(chatId, 'typing')
  await sleep(ms)
}

async function send(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options })
}

function parseQuantity(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|lt|litri|pezzi|bottiglie|sacche?|cassette?|confezioni?)?/i)
  if (!match) return null
  const num = parseFloat(match[1].replace(',', '.'))
  const unit = match[2] || 'unità'
  return { value: num, unit }
}

function yesNoKeyboard() {
  return {
    reply_markup: {
      keyboard: [['✅ Sì', '❌ No'], ['⏭ Salta per ora']],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  }
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } }
}

function posKeyboard() {
  return {
    reply_markup: {
      keyboard: [['Cassa in Cloud', 'Tilby'], ['Lightspeed', 'Square'], ['Altro', '❌ Non ce l\'ho']],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  }
}

async function startOnboarding(chatId) {
  await db.upsertRestaurant(chatId, { step: 'welcome' })
  await typing(chatId, 1000)
  await send(chatId, `👋 <b>Ciao! Sono il tuo assistente rifornimenti.</b>\n\nTi aiuto a tenere sotto controllo le scorte e fare ordini ai fornitori.\n\nIniziamo?`, yesNoKeyboard())
  await db.upsertRestaurant(chatId, { step: 'awaiting_start' })
}

async function askProfile(chatId) {
  await typing(chatId, 800)
  await send(chatId, `Prima di tutto: <b>come si chiama il tuo ristorante?</b>`, removeKeyboard())
  await db.upsertRestaurant(chatId, { step: 'awaiting_name' })
}

async function askRestaurantType(chatId, name) {
  await db.upsertRestaurant(chatId, { profile: { name }, step: 'awaiting_type' })
  await typing(chatId, 800)
  await send(chatId, `Ottimo, <b>${name}</b>! 🍽\n\nChe tipo di locale è?`, {
    reply_markup: {
      keyboard: [['🍕 Pizzeria', '🍝 Ristorante'], ['🍷 Bistrot / Osteria', '🥐 Bakery / Caffè'], ['Altro']],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  })
}

async function askCovers(chatId, type) {
  const rest = await db.getRestaurant(chatId)
  await db.upsertRestaurant(chatId, { profile: { ...rest.profile, type }, step: 'awaiting_covers' })
  await typing(chatId, 800)
  await send(chatId, `Quanti coperti avete in media a servizio?`, removeKeyboard())
}

async function askPOS(chatId, covers) {
  const rest = await db.getRestaurant(chatId)
  await db.upsertRestaurant(chatId, { profile: { ...rest.profile, covers: parseInt(covers) || 50 }, step: 'awaiting_pos' })
  await typing(chatId, 1000)
  await send(chatId, `Perfetto! Hai un sistema di cassa digitale?`, posKeyboard())
}

async function handlePOSChoice(chatId, choice) {
  const hasPOS = !choice.includes('Non ce')
  await db.upsertRestaurant(chatId, { pos_type: hasPOS ? choice : null, step: 'awaiting_menu' })
  await typing(chatId, 1000)
  await send(chatId, `Ora passiamo al menu. <b>Mandami una foto del tuo menu</b> o scrivimi i piatti principali.`, removeKeyboard())
}

async function handleIngredientsList(chatId, text) {
  const rest = await db.getRestaurant(chatId)
  const lines = text.split('\n').filter(l => l.trim())
  const ingredients = []
  for (const line of lines) {
    const parts = line.split(/[—\-:]/)
    if (parts.length >= 2) {
      const name = parts[0].trim()
      const qty = parseQuantity(parts[1].trim())
      if (name && qty) ingredients.push({ name, weeklyOrder: qty.value, unit: qty.unit })
    }
  }
  if (ingredients.length > 0) {
    await db.bulkAddIngredients(rest.id, ingredients)
    await db.upsertRestaurant(chatId, { step: 'active', onboarding_complete: true })
    await send(chatId, `✅ Salvati! Setup completato. Da stasera riceverai i report.`)
  }
}

bot.onText(/\/start/, async (msg) => {
  await startOnboarding(msg.chat.id)
})

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return
  const chatId = msg.chat.id
  const rest = await db.getRestaurant(chatId)
  if (!rest) return

  switch (rest.step) {
    case 'awaiting_start':
      if (msg.text?.includes('Sì')) await askProfile(chatId)
      break
    case 'awaiting_name':
      await askRestaurantType(chatId, msg.text)
      break
    case 'awaiting_type':
      await askCovers(chatId, msg.text)
      break
    case 'awaiting_covers':
      await askPOS(chatId, msg.text)
      break
    case 'awaiting_pos':
      await handlePOSChoice(chatId, msg.text)
      break
    case 'awaiting_ingredients':
      await handleIngredientsList(chatId, msg.text)
      break
    case 'active':
      const response = await ai.chat(msg.text, rest)
      await send(chatId, response)
      break
  }
})

cron.schedule('0 23 * * *', async () => {
  const actives = await db.getAllActiveRestaurants()
  for (const rest of actives) {
    await send(rest.chat_id, "📊 Ecco il tuo report serale...")
  }
}, { timezone: 'Europe/Rome' })

console.log("🚀 Bot Online con Supabase!")
