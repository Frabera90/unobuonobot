// bot.js — Assistente Rifornimenti per Ristoranti
require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api')
const cron = require('node-cron')
const db = require('./db')
const ai = require('./ai')

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

// ─── UTILITIES ────────────────────────────────────────────────────────────────

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

// ─── KEYBOARD HELPERS ─────────────────────────────────────────────────────────

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
      keyboard: [
        ['Cassa in Cloud', 'Tilby'],
        ['Lightspeed', 'Square'],
        ['Altro', '❌ Non ce l\'ho']
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  }
}

// ─── ONBOARDING FLOWS ─────────────────────────────────────────────────────────

async function startOnboarding(chatId) {
  await db.upsertRestaurant(chatId, { step: 'welcome' })

  await typing(chatId, 1000)
  await send(chatId, `👋 <b>Ciao! Sono il tuo assistente rifornimenti.</b>

Ti aiuto a tenere sotto controllo le scorte del tuo ristorante e a fare ordini ai fornitori — tutto da qui, su Telegram.

Niente da installare, niente da imparare. Ti faccio alcune domande e poi penso a tutto io. 🍕

Iniziamo?`, yesNoKeyboard())

  await db.upsertRestaurant(chatId, { step: 'awaiting_start' })
}

async function askProfile(chatId) {
  await typing(chatId, 800)
  await send(chatId, `Prima di tutto: <b>come si chiama il tuo ristorante?</b>`, removeKeyboard())
  await db.upsertRestaurant(chatId, { step: 'awaiting_name' })
}

async function askRestaurantType(chatId, name) {
  await db.upsertRestaurant(chatId, {
    profile: { name },
    step: 'awaiting_type'
  })

  await typing(chatId, 800)
  await send(chatId, `Ottimo, <b>${name}</b>! 🍽

Che tipo di locale è?`, {
    reply_markup: {
      keyboard: [
        ['🍕 Pizzeria', '🍝 Ristorante'],
        ['🍷 Bistrot / Osteria', '🥐 Bakery / Caffè'],
        ['Altro']
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  })
}

async function askCovers(chatId, type) {
  const rest = await db.getRestaurant(chatId)
  await db.upsertRestaurant(chatId, {
    profile: { ...rest.profile, type },
    step: 'awaiting_covers'
  })

  await typing(chatId, 800)
  await send(chatId, `Quanti coperti avete in media a servizio? (un numero approssimativo va benissimo)`, removeKeyboard())
}

async function askPOS(chatId, covers) {
  const rest = await db.getRestaurant(chatId)
  await db.upsertRestaurant(chatId, {
    profile: { ...rest.profile, covers: parseInt(covers) || 50 },
    step: 'awaiting_pos'
  })

  await typing(chatId, 1000)
  await send(chatId, `Perfetto! Ultima cosa sul profilo: <b>hai un sistema di cassa digitale?</b>

Se mi dai accesso ai dati di vendita, divento molto più preciso sulle scorte. Ma non è obbligatorio — funziono benissimo anche senza.`, posKeyboard())
}

async function handlePOSChoice(chatId, choice) {
  const hasPOS = !choice.includes('Non ce')
  await db.upsertRestaurant(chatId, {
    pos_type: hasPOS ? choice : null,
    step: 'awaiting_menu'
  })

  await typing(chatId, 1000)

  if (hasPOS) {
    await send(chatId, `✅ <b>${choice}</b> — ottima scelta. Ti chiederò le credenziali API più avanti per collegarlo.

Ora passiamo al menu. <b>Mandami una foto del tuo menu</b> (anche dal telefono va bene), oppure scrivimi i tuoi piatti principali.`, removeKeyboard())
  } else {
    await send(chatId, `Nessun problema! Imparo dai tuoi ordini e miglioro nel tempo. 📈

Ora passiamo al menu. <b>Mandami una foto del tuo menu</b> (anche dal telefono va bene), oppure scrivimi i tuoi piatti principali.`, removeKeyboard())
  }
}

async function handleMenuPhoto(chatId, photo) {
  await typing(chatId, 500)
  await bot.sendChatAction(chatId, 'typing')

  const fileId = photo[photo.length - 1].file_id
  const fileLink = await bot.getFileLink(fileId)

  const https = require('https')
  const imageBuffer = await new Promise((resolve, reject) => {
    https.get(fileLink, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
  })

  const imageBase64 = imageBuffer.toString('base64')
  await send(chatId, '📷 Sto leggendo il menu...')

  try {
    const result = await ai.extractMenuFromPhoto(imageBase64, 'image/jpeg')
    const rest = await db.getRestaurant(chatId)

    if (result.piatti && result.piatti.length > 0) {
      await db.bulkAddMenuItems(rest.id, result.piatti)
      await db.upsertRestaurant(chatId, { step: 'menu_confirm' })

      let text = '✅ <b>Ho trovato i tuoi piatti.</b> È corretto? Posso procedere con gli ingredienti.'
      await send(chatId, text, yesNoKeyboard())
    } else {
      await send(chatId, 'Non sono riuscito a leggere bene il menu. Prova con una foto più nitida o scrivili.', removeKeyboard())
    }
  } catch (err) {
    await send(chatId, '❌ Errore nella lettura della foto.')
  }
}

async function askIngredients(chatId) {
  await db.upsertRestaurant(chatId, { step: 'awaiting_ingredients' })

  await typing(chatId, 1000)
  await send(chatId, `🥬 <b>Ingredienti critici</b>

Dimmi i tuoi <b>ingredienti principali</b> (5-8 bastano).
<b>Esempio:
Farina tipo 1 — 50kg
Mozzarella — 8kg</b>`, removeKeyboard())
}

async function handleIngredientsList(chatId, text) {
  const rest = await db.getRestaurant(chatId)
  const lines = text.split('\n').filter(l => l.trim() && l.toLowerCase() !== 'fine')
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
    await db.upsertRestaurant(chatId, { step: 'awaiting_suppliers' })
    await send(chatId, `✅ Salvati! Chi ti porta la <b>${ingredients[0].name}</b>? (Nome e WhatsApp)`)
  }
}

async function askInitialStock(chatId) {
  const rest = await db.getRestaurant(chatId)
  const ctx = await db.getFullContext(rest.id)

  await typing(chatId, 1000)
  let stockText = '📦 <b>Come sei messo con queste cose?</b>\n\n'
  ctx.ingredients.forEach((ing, i) => {
    stockText += `${i + 1}. ${ing.name} (norm. ${ing.weekly_order}${ing.unit})\n`
  })

  stockText += '\n<i>Scrivi es. "1. ok, 2. quasi finita"</i>'
  await send(chatId, stockText, removeKeyboard())
  await db.upsertRestaurant(chatId, { step: 'awaiting_initial_stock' })
}

async function handleInitialStock(chatId, text) {
  const rest = await db.getRestaurant(chatId)
  const ctx = await db.getFullContext(rest.id)
  
  // Logica semplificata per demo
  await db.upsertRestaurant(chatId, { onboarding_complete: true, step: 'active' })

  await typing(chatId, 1500)
  await send(chatId, `🎉 <b>Setup completato!</b>\n\nDa stasera alle 23:00 ti manderò i report.\nScrivi /magazzino per vedere lo stato.`)
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  await startOnboarding(msg.chat.id)
})

bot.onText(/\/magazzino/, async (msg) => {
  const rest = await db.getRestaurant(msg.chat.id)
  if (!rest || !rest.onboarding_complete) return send(msg.chat.id, 'Usa /start prima!')
  
  const ctx = await db.getFullContext(rest.id)
  let text = `📦 <b>Stato scorte:</b>\n`
  ctx.ingredients.forEach(ing => {
    text += `• ${ing.name}: ${ing.current_stock}${ing.unit}\n`
  })
  await send(msg.chat.id, text)
})

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return
  const chatId = msg.chat.id
  const rest = await db.getRestaurant(chatId)
  if (!rest) return

  if (msg.photo && rest.step === 'awaiting_menu') return handleMenuPhoto(chatId, msg.photo)

  switch (rest.step) {
    case 'awaiting_start':
      if (msg.text?.includes('Sì')) await askProfile(chatId)
      break
    case 'awaiting_name':
      await askRestaurantType(chatId, msg.text)
      break
    case 'awaiting_ingredients':
      await handleIngredientsList(chatId, msg.text)
      break
    case 'awaiting_initial_stock':
      await handleInitialStock(chatId, msg.text)
      break
    case 'active':
      const response = await ai.chat(msg.text, rest)
      await send(chatId, response)
      break
  }
})

// ─── CRON ─────────────────────────────────────────────────────────────────────

cron.schedule('0 23 * * *', async () => {
  const actives = await db.getAllActiveRestaurants()
  for (const rest of actives) {
    await send(rest.chat_id, "📊 Ecco il tuo report serale...")
  }
}, { timezone: 'Europe/Rome' })

console.log("🚀 Bot Online con Supabase!")
```[cite: 1, 2]
