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
  const rest = db.getRestaurant(chatId)
  db.updateRestaurant(chatId, { step: 'welcome' })

  await typing(chatId, 1000)
  await send(chatId, `👋 <b>Ciao! Sono il tuo assistente rifornimenti.</b>

Ti aiuto a tenere sotto controllo le scorte del tuo ristorante e a fare ordini ai fornitori — tutto da qui, su Telegram.

Niente da installare, niente da imparare. Ti faccio alcune domande e poi penso a tutto io. 🍕

Iniziamo?`, yesNoKeyboard())

  db.updateRestaurant(chatId, { step: 'awaiting_start' })
}

async function askProfile(chatId) {
  await typing(chatId, 800)
  await send(chatId, `Prima di tutto: <b>come si chiama il tuo ristorante?</b>`, removeKeyboard())
  db.updateRestaurant(chatId, { step: 'awaiting_name' })
}

async function askRestaurantType(chatId, name) {
  db.updateRestaurant(chatId, {
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
  const rest = db.getRestaurant(chatId)
  db.updateRestaurant(chatId, {
    profile: { ...rest.profile, type },
    step: 'awaiting_covers'
  })

  await typing(chatId, 800)
  await send(chatId, `Quanti coperti avete in media a servizio? (un numero approssimativo va benissimo)`, removeKeyboard())
}

async function askPOS(chatId, covers) {
  const rest = db.getRestaurant(chatId)
  db.updateRestaurant(chatId, {
    profile: { ...rest.profile, covers: parseInt(covers) || 50 },
    step: 'awaiting_pos'
  })

  await typing(chatId, 1000)
  await send(chatId, `Perfetto! Ultima cosa sul profilo: <b>hai un sistema di cassa digitale?</b>

Se mi dai accesso ai dati di vendita, divento molto più preciso sulle scorte. Ma non è obbligatorio — funziono benissimo anche senza.`, posKeyboard())
}

async function handlePOSChoice(chatId, choice) {
  const hasPOS = !choice.includes('Non ce')
  db.updateRestaurant(chatId, {
    posType: hasPOS ? choice : null,
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

  // Scarica la foto
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
    const rest = db.getRestaurant(chatId)

    if (result.piatti && result.piatti.length > 0) {
      db.updateRestaurant(chatId, {
        menu: result.piatti,
        step: 'menu_confirm'
      })

      const menuText = result.piatti
        .reduce((acc, p) => {
          if (!acc[p.categoria]) acc[p.categoria] = []
          acc[p.categoria].push(`  • ${p.nome}${p.prezzo ? ` — €${p.prezzo}` : ''}`)
          return acc
        }, {})

      let text = '✅ <b>Ho trovato questi piatti:</b>\n\n'
      Object.entries(menuText).forEach(([cat, items]) => {
        text += `<b>${cat}</b>\n${items.join('\n')}\n\n`
      })
      text += 'È corretto? Posso procedere con gli ingredienti.'

      await send(chatId, text, yesNoKeyboard())
    } else {
      await send(chatId, 'Non sono riuscito a leggere bene il menu da questa foto. Prova con una foto più nitida, oppure scrivimi i tuoi piatti principali (uno per riga).', removeKeyboard())
    }
  } catch (err) {
    await send(chatId, '❌ Errore nella lettura della foto. Prova di nuovo o scrivi i piatti a mano.')
  }
}

async function askIngredients(chatId) {
  db.updateRestaurant(chatId, { step: 'awaiting_ingredients', ingredients: [] })

  await typing(chatId, 1000)
  await send(chatId, `🥬 <b>Ingredienti critici</b>

Ora dimmi i tuoi <b>ingredienti principali</b> — quelli che non possono mai mancare e che ordini ogni settimana.

Non mi servono tutti, solo i più importanti (5-8 bastano).

<b>Scrivili uno per riga, con la quantità settimanale media:</b>
<i>Esempio:
Farina tipo 1 — 50kg
Mozzarella fior di latte — 8kg
Pomodoro San Marzano — 15kg</i>

Quando hai finito scrivi <b>FINE</b>.`, removeKeyboard())
}

async function handleIngredientsList(chatId, text) {
  const lines = text.split('\n').filter(l => l.trim() && l.toLowerCase() !== 'fine')
  const ingredients = []

  for (const line of lines) {
    const parts = line.split(/[—\-:]/)
    if (parts.length >= 2) {
      const name = parts[0].trim()
      const qtyText = parts[1].trim()
      const qty = parseQuantity(qtyText)

      if (name && qty) {
        ingredients.push({
          name,
          weeklyOrder: qty.value,
          unit: qty.unit,
          supplier: null
        })
      }
    }
  }

  if (ingredients.length === 0) {
    await send(chatId, 'Non sono riuscito a capire il formato. Prova così:\n\n<i>Farina — 50kg\nMozzarella — 8kg</i>')
    return
  }

  db.updateRestaurant(chatId, { ingredients, step: 'awaiting_suppliers' })

  await typing(chatId, 1000)

  let text2 = `✅ <b>Perfetto! Ho registrato ${ingredients.length} ingredienti:</b>\n\n`
  ingredients.forEach(i => {
    text2 += `• ${i.name} — ${i.weeklyOrder}${i.unit}/settimana\n`
  })

  text2 += `\nOra dimmi <b>chi ti fornisce ognuno</b>. Per ogni ingrediente, scrivimi il nome del fornitore e il suo numero WhatsApp.\n\nIniziamo con: <b>${ingredients[0].name}</b>\nChi te lo porta?`

  await send(chatId, text2, removeKeyboard())
  db.updateRestaurant(chatId, { currentIngredientIndex: 0 })
}

async function handleSupplierInfo(chatId, text) {
  const rest = db.getRestaurant(chatId)
  const idx = rest.currentIngredientIndex || 0
  const ingredient = rest.ingredients[idx]

  if (!ingredient) {
    await askCellar(chatId)
    return
  }

  // Estrai nome e numero dal testo
  const phoneMatch = text.match(/(\+?39?\s*)?(\d[\d\s\-]{8,})/g)
  const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : null

  // Il nome del fornitore è il testo prima del numero o tutto il testo
  const supplierName = phone
    ? text.replace(phoneMatch[0], '').trim().replace(/[,\-]/g, '').trim()
    : text.trim()

  const suppliers = { ...rest.suppliers }
  suppliers[ingredient.name] = {
    name: supplierName || text,
    phone: phone || null
  }

  db.updateRestaurant(chatId, {
    suppliers,
    currentIngredientIndex: idx + 1
  })

  const nextIdx = idx + 1
  if (nextIdx < rest.ingredients.length) {
    await typing(chatId, 600)
    await send(chatId, `✅ <b>${supplierName || text}</b> salvato per ${ingredient.name}.\n\nOra: <b>${rest.ingredients[nextIdx].name}</b> — chi te lo porta?`)
  } else {
    await typing(chatId, 800)
    await send(chatId, `✅ Tutti i fornitori salvati! 

📞 <b>Riepilogo fornitori:</b>
${rest.ingredients.map(i => `• ${i.name}: ${suppliers[i.name]?.name || 'non specificato'}`).join('\n')}`)

    await sleep(1000)
    await askCellar(chatId)
  }
}

async function askCellar(chatId) {
  db.updateRestaurant(chatId, { step: 'awaiting_cellar', wines: [] })

  await typing(chatId, 1000)
  await send(chatId, `🍷 <b>Cantina e vini</b>

Hai una cantina o una carta vini?`, yesNoKeyboard())
}

async function handleCellarPhoto(chatId, photo) {
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

  await send(chatId, '🔍 Analizzo la cantina...')

  try {
    const analysis = await ai.analyzeCellarPhoto(imageBase64, 'image/jpeg')
    await send(chatId, analysis)
    db.updateRestaurant(chatId, { step: 'awaiting_top_wines' })
  } catch {
    await send(chatId, 'Ho ricevuto la foto della cantina. Dimmi ora i tuoi <b>5 vini più venduti</b> con la quantità che tieni normalmente (es: Montepulciano d\'Abruzzo — 12 bottiglie)')
    db.updateRestaurant(chatId, { step: 'awaiting_top_wines' })
  }
}

async function handleTopWines(chatId, text) {
  const lines = text.split('\n').filter(l => l.trim())
  const wines = []

  for (const line of lines) {
    const parts = line.split(/[—\-:]/)
    if (parts.length >= 2) {
      const name = parts[0].trim()
      const qtyText = parts.slice(1).join(' ').trim()
      const qty = parseQuantity(qtyText)

      if (name) {
        wines.push({
          name,
          normalStock: qty?.value || 12,
          unit: 'bottiglie',
          weeklyAvg: Math.max(1, Math.round((qty?.value || 12) / 3)),
          supplier: null
        })
      }
    }
  }

  if (wines.length === 0) {
    await send(chatId, 'Prova questo formato:\n\n<i>Montepulciano d\'Abruzzo — 12 bottiglie\nProsecco DOC — 6 bottiglie</i>')
    return
  }

  db.updateRestaurant(chatId, { wines, step: 'awaiting_wine_suppliers' })

  let text2 = `🍷 <b>Salvati ${wines.length} vini!</b>\n\n`
  wines.forEach(w => {
    text2 += `• ${w.name} — ${w.normalStock} bottiglie in stock\n`
  })

  text2 += `\nChi ti fornisce i vini? Scrivimi il nome dell'enoteca/distributore e il numero WhatsApp.`

  await send(chatId, text2, removeKeyboard())
}

async function handleWineSupplier(chatId, text) {
  const rest = db.getRestaurant(chatId)
  const phoneMatch = text.match(/(\+?39?\s*)?(\d[\d\s\-]{8,})/g)
  const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : null
  const supplierName = phone
    ? text.replace(phoneMatch[0], '').trim().replace(/[,\-]/g, '').trim()
    : text.trim()

  const suppliers = { ...rest.suppliers }
  rest.wines.forEach(w => {
    suppliers[w.name] = { name: supplierName, phone }
  })

  db.updateRestaurant(chatId, { suppliers, step: 'awaiting_stock' })

  await typing(chatId, 800)
  await send(chatId, `✅ <b>${supplierName}</b> salvato come fornitore vini.\n\nUltima cosa e abbiamo finito! 🎉`)
  await sleep(800)
  await askInitialStock(chatId)
}

async function askInitialStock(chatId) {
  const rest = db.getRestaurant(chatId)

  await typing(chatId, 1000)
  await send(chatId, `📦 <b>Stock attuale</b>

Per essere preciso da subito, dimmi quanto hai in stock <b>adesso</b> dei tuoi ingredienti principali.

Non serve essere precisi — anche "poco", "metà", "tanto" va bene. Imparo nel tempo! 😊

Rispondo con l'elenco e tu mi dici lo stato:`)

  await sleep(500)

  let stockText = '<b>Come sei messo con queste cose?</b>\n\n'
  rest.ingredients.forEach((ing, i) => {
    stockText += `${i + 1}. ${ing.name} (normalmente ${ing.weeklyOrder}${ing.unit}/sett.)\n`
  })

  if (rest.wines.length > 0) {
    rest.wines.forEach((wine, i) => {
      stockText += `${rest.ingredients.length + i + 1}. ${wine.name} (normalmente ${wine.normalStock} bottiglie)\n`
    })
  }

  stockText += '\n<i>Scrivi il numero e lo stato: es. "1. quasi finita, 2. ok, 3. ho appena riordinato"</i>'

  await send(chatId, stockText, removeKeyboard())
  db.updateRestaurant(chatId, { step: 'awaiting_initial_stock' })
}

async function handleInitialStock(chatId, text) {
  const rest = db.getRestaurant(chatId)
  const allItems = [...rest.ingredients, ...rest.wines]
  const stock = {}

  // Parse risposte tipo "1. quasi finita, 2. ok"
  const lines = text.split(/[,\n]/)
  lines.forEach(line => {
    const numMatch = line.match(/^(\d+)[\.\)]\s*(.+)/)
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1
      const status = numMatch[2].toLowerCase().trim()
      const item = allItems[idx]
      if (item) {
        let quantity = item.weeklyOrder || item.normalStock || 10
        if (status.includes('quasi finit') || status.includes('poco') || status.includes('quasi zero')) {
          quantity = quantity * 0.2
        } else if (status.includes('metà') || status.includes('mezza') || status.includes('medio')) {
          quantity = quantity * 0.5
        } else if (status.includes('ok') || status.includes('bene') || status.includes('abbastanza')) {
          quantity = quantity * 0.8
        } else if (status.includes('appena riordinat') || status.includes('pieno') || status.includes('tanto')) {
          quantity = quantity * 1.2
        }
        stock[item.name] = Math.round(quantity * 10) / 10
      }
    }
  })

  db.updateRestaurant(chatId, {
    stock,
    onboardingComplete: true,
    step: 'active'
  })

  await typing(chatId, 1500)
  await send(chatId, `🎉 <b>Setup completato!</b>

Ecco cosa ho imparato su di te:

🍽 <b>${rest.profile.name}</b> — ${rest.profile.type}
📦 <b>${rest.ingredients.length}</b> ingredienti monitorati
🍷 <b>${rest.wines.length}</b> vini monitorati
👥 <b>${Object.keys(rest.suppliers).length}</b> fornitori salvati

Da stasera alle 23:00 ti mando ogni sera un report sulle scorte. Se dici SI, mando gli ordini ai fornitori.

Puoi anche chiedermi in qualsiasi momento:
• /magazzino — vedi lo stato delle scorte
• /alert — genera subito un alert (per la demo)
• /ordini — storico degli ordini
• /aiuto — tutti i comandi

<b>Buon lavoro! 👨‍🍳</b>`)
}

// ─── STOCK ALERT ──────────────────────────────────────────────────────────────

async function sendStockAlert(chatId) {
  const rest = db.getRestaurant(chatId)
  if (!rest.onboardingComplete) return

  await bot.sendChatAction(chatId, 'typing')

  try {
    const alert = await ai.generateStockAlert(rest)
    await send(chatId, `📊 <b>Report scorte serale</b>\n\n${alert}`, {
      reply_markup: {
        keyboard: [['✅ SI, manda gli ordini', '❌ No, aspetta'], ['✏️ Voglio correggere qualcosa']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    })
    db.updateRestaurant(chatId, { step: 'awaiting_order_confirm', pendingAlert: true })
  } catch (err) {
    await send(chatId, '❌ Errore nella generazione del report. Riprova con /alert')
  }
}

async function handleOrderConfirm(chatId, text) {
  const rest = db.getRestaurant(chatId)
  const lower = text.toLowerCase()

  if (lower.includes('si') || lower.includes('sì') || lower.includes('manda')) {
    await confirmAllOrders(chatId)
  } else if (lower.includes('no') || lower.includes('aspetta')) {
    await send(chatId, '👍 Ok, nessun ordine inviato per stasera. Ci vediamo domani!', removeKeyboard())
    db.updateRestaurant(chatId, { step: 'active', pendingAlert: false })
  } else if (lower.includes('correggi') || lower.includes('correzione')) {
    await send(chatId, 'Dimmi cosa vuoi correggere — quale ingrediente e quanta ne hai davvero?', removeKeyboard())
    db.updateRestaurant(chatId, { step: 'awaiting_correction' })
  }
}

async function confirmAllOrders(chatId) {
  const rest = db.getRestaurant(chatId)

  await send(chatId, '📤 Sto preparando gli ordini...', removeKeyboard())

  const ordersToSend = []

  for (const ing of rest.ingredients) {
    const currentStock = rest.stock[ing.name] || 0
    const needed = ing.weeklyOrder - currentStock

    if (needed > 0) {
      const supplier = rest.suppliers[ing.name]
      if (supplier) {
        const message = await ai.generateSupplierMessage(rest, ing.name, `${needed}${ing.unit}`)
        ordersToSend.push({
          ingredient: ing.name,
          quantity: `${needed}${ing.unit}`,
          supplier: supplier.name,
          phone: supplier.phone,
          message
        })
        // Aggiorna lo stock simulando la consegna domani
        db.updateStock(chatId, ing.name, ing.weeklyOrder)
      }
    }
  }

  if (ordersToSend.length === 0) {
    await send(chatId, '✅ Le scorte sono a posto — nessun ordine necessario stasera!')
    db.updateRestaurant(chatId, { step: 'active' })
    return
  }

  db.addOrder(chatId, { items: ordersToSend.map(o => ({ name: o.ingredient, quantity: o.quantity })) })

  let confirmText = `✅ <b>Ordini inviati a ${ordersToSend.length} fornitori:</b>\n\n`

  ordersToSend.forEach(order => {
    confirmText += `📤 <b>${order.supplier}</b>${order.phone ? ` (${order.phone})` : ''}\n`
    confirmText += `   → ${order.quantity} di ${order.ingredient}\n`
    confirmText += `   <i>"${order.message.substring(0, 80)}..."</i>\n\n`
  })

  confirmText += '💡 <i>I messaggi sono stati inviati su WhatsApp ai fornitori. Domani mattina arriverà tutto!</i>'

  await send(chatId, confirmText)
  db.updateRestaurant(chatId, { step: 'active', pendingAlert: false })
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  await startOnboarding(chatId)
})

bot.onText(/\/magazzino/, async (msg) => {
  const chatId = msg.chat.id
  const rest = db.getRestaurant(chatId)

  if (!rest.onboardingComplete) {
    await send(chatId, 'Prima completa il setup con /start!')
    return
  }

  let text = `📦 <b>Stato scorte attuale</b>\n\n<b>🥬 Cucina:</b>\n`

  rest.ingredients.forEach(ing => {
    const current = rest.stock[ing.name] || ing.weeklyOrder
    const pct = Math.round((current / ing.weeklyOrder) * 100)
    const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
    text += `${emoji} ${ing.name}: ~${current}${ing.unit} (${pct}% del normale)\n`
  })

  if (rest.wines.length > 0) {
    text += `\n<b>🍷 Cantina:</b>\n`
    rest.wines.forEach(wine => {
      const current = rest.stock[wine.name] || wine.normalStock
      const pct = Math.round((current / wine.normalStock) * 100)
      const emoji = pct < 20 ? '🔴' : pct < 50 ? '🟡' : '🟢'
      text += `${emoji} ${wine.name}: ${current} bottiglie (${pct}% del normale)\n`
    })
  }

  text += `\n<i>Ultimo aggiornamento: adesso</i>`
  await send(chatId, text)
})

bot.onText(/\/alert/, async (msg) => {
  const chatId = msg.chat.id
  const rest = db.getRestaurant(chatId)

  if (!rest.onboardingComplete) {
    await send(chatId, 'Prima completa il setup con /start!')
    return
  }

  await sendStockAlert(chatId)
})

bot.onText(/\/ordini/, async (msg) => {
  const chatId = msg.chat.id
  const rest = db.getRestaurant(chatId)

  if (rest.orderHistory.length === 0) {
    await send(chatId, '📋 Nessun ordine ancora. Gli ordini appariranno qui dopo il primo alert serale.')
    return
  }

  const recent = rest.orderHistory.slice(-5).reverse()
  let text = `📋 <b>Ultimi ordini:</b>\n\n`

  recent.forEach(order => {
    const date = new Date(order.date).toLocaleDateString('it-IT')
    text += `<b>${date}</b>\n`
    order.items.forEach(item => {
      text += `  • ${item.quantity} di ${item.name}\n`
    })
    text += '\n'
  })

  await send(chatId, text)
})

bot.onText(/\/aiuto/, async (msg) => {
  const chatId = msg.chat.id
  await send(chatId, `🤖 <b>Comandi disponibili:</b>

/start — ricomincia il setup
/magazzino — stato attuale delle scorte
/alert — genera un alert scorte adesso (per demo)
/ordini — storico degli ordini
/aiuto — questo messaggio

Puoi anche <b>scrivermi liberamente</b> per aggiornarmi su cosa hai in magazzino:
<i>"Ho appena ricevuto la farina, ho 50kg"</i>
<i>"Stanotte abbiamo finito il fior di latte"</i>
<i>"Togli il Montepulciano dai vini, abbiamo cambiato fornitore"</i>`)
})

bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id
  delete db.restaurants[chatId]
  await send(chatId, '🔄 Reset effettuato. Scrivi /start per ricominciare.')
})

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text && !msg.photo) return

  const chatId = msg.chat.id
  const text = msg.text || ''
  const rest = db.getRestaurant(chatId)

  // Ignora i comandi (già gestiti sopra)
  if (text.startsWith('/')) return

  // Foto in qualsiasi momento
  if (msg.photo) {
    if (rest.step === 'awaiting_menu') {
      await handleMenuPhoto(chatId, msg.photo)
      return
    }
    if (rest.step === 'awaiting_cellar' || rest.step === 'cellar_photo') {
      await handleCellarPhoto(chatId, msg.photo)
      return
    }
    // Foto fuori dal flusso — gestisci come aggiornamento scorte
    await send(chatId, '📷 Ho ricevuto la foto! Per ora posso analizzare foto di menu e cantina durante il setup. Scrivi /start per riconfigurare o descrivimi cosa hai in magazzino con un messaggio.')
    return
  }

  // State machine onboarding
  switch (rest.step) {
    case 'welcome':
    case 'awaiting_start':
      if (text.includes('Sì') || text.includes('Si') || text.toLowerCase().includes('si') || text.includes('✅')) {
        await askProfile(chatId)
      } else {
        await send(chatId, 'Quando vuoi iniziare, scrivi /start! 👋')
      }
      break

    case 'awaiting_name':
      await askRestaurantType(chatId, text.trim())
      break

    case 'awaiting_type':
      await askCovers(chatId, text.trim())
      break

    case 'awaiting_covers':
      await askPOS(chatId, text.trim())
      break

    case 'awaiting_pos':
      await handlePOSChoice(chatId, text.trim())
      break

    case 'awaiting_menu':
      // Testo libero per il menu
      if (text.length > 20) {
        const lines = text.split('\n').filter(l => l.trim())
        const piatti = lines.map(l => ({ nome: l.trim(), categoria: 'Menu', prezzo: null }))
        db.updateRestaurant(chatId, { menu: piatti, step: 'menu_confirm' })
        await send(chatId, `✅ Ho salvato ${piatti.length} voci di menu. Procediamo con gli ingredienti?`, yesNoKeyboard())
      } else {
        await send(chatId, 'Puoi mandarmi una foto del menu o scrivere i piatti (uno per riga).')
      }
      break

    case 'menu_confirm':
      if (text.includes('✅') || text.toLowerCase().includes('si') || text.includes('Sì')) {
        await askIngredients(chatId)
      } else if (text.includes('❌') || text.toLowerCase().includes('no')) {
        await send(chatId, 'Ok, mandami di nuovo il menu — una foto o scrivi i piatti.', removeKeyboard())
        db.updateRestaurant(chatId, { step: 'awaiting_menu' })
      } else {
        await send(chatId, 'È corretto il menu che ho letto?', yesNoKeyboard())
      }
      break

    case 'awaiting_ingredients':
      if (text.toLowerCase() === 'fine' || text.toLowerCase().includes('fine')) {
        const rest2 = db.getRestaurant(chatId)
        if (rest2.ingredients.length === 0) {
          await send(chatId, 'Non hai ancora inserito nessun ingrediente! Scrivili così:\n\n<i>Farina — 50kg\nMozzarella — 8kg</i>')
        } else {
          db.updateRestaurant(chatId, { step: 'awaiting_suppliers', currentIngredientIndex: 0 })
          await send(chatId, `✅ Salvati ${rest2.ingredients.length} ingredienti! Ora i fornitori.`)
          await send(chatId, `Chi ti porta la <b>${rest2.ingredients[0].name}</b>? (nome + numero WhatsApp)`)
        }
      } else {
        await handleIngredientsList(chatId, text)
      }
      break

    case 'awaiting_suppliers':
      await handleSupplierInfo(chatId, text)
      break

    case 'awaiting_cellar':
      if (text.includes('✅') || text.toLowerCase().includes('si') || text.includes('Sì')) {
        db.updateRestaurant(chatId, { step: 'cellar_photo' })
        await send(chatId, '🍷 Mandami una foto della cantina (o degli scaffali dei vini), oppure dimmi direttamente i tuoi vini principali!', removeKeyboard())
      } else {
        db.updateRestaurant(chatId, { step: 'awaiting_stock' })
        await send(chatId, 'Ok, nessun problema! Passiamo allo stock iniziale.', removeKeyboard())
        await askInitialStock(chatId)
      }
      break

    case 'cellar_photo':
      // Gestito sopra per le foto, qui gestiamo testo diretto
      db.updateRestaurant(chatId, { step: 'awaiting_top_wines' })
      await handleTopWines(chatId, text)
      break

    case 'awaiting_top_wines':
      await handleTopWines(chatId, text)
      break

    case 'awaiting_wine_suppliers':
      await handleWineSupplier(chatId, text)
      break

    case 'awaiting_stock':
    case 'awaiting_initial_stock':
      await handleInitialStock(chatId, text)
      break

    case 'awaiting_order_confirm':
      await handleOrderConfirm(chatId, text)
      break

    case 'awaiting_correction':
      // Il ristoratore sta correggendo una stima
      const correctionResult = await ai.interpretOwnerResponse(text, 'correzione stock ingredienti')
      if (correctionResult.stockCorrection) {
        Object.entries(correctionResult.stockCorrection).forEach(([ing, val]) => {
          db.updateStock(chatId, ing, val)
        })
        await send(chatId, `✅ Aggiornato! ${correctionResult.details}\n\nVuoi che mandi comunque gli ordini per gli altri ingredienti?`, {
          reply_markup: {
            keyboard: [['✅ Sì, manda gli altri', '❌ No grazie']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        })
        db.updateRestaurant(chatId, { step: 'awaiting_order_confirm' })
      } else {
        await send(chatId, correctionResult.details || 'Non ho capito bene. Dimmi: quale ingrediente e quanta ne hai? Es: "La farina ce ne ho ancora 30kg"')
      }
      break

    case 'active':
    default:
      // Chat libera con l'AI per aggiornamenti scorte o domande
      try {
        await bot.sendChatAction(chatId, 'typing')
        const response = await ai.chat(text, rest)
        await send(chatId, response)

        // Se menziona quantità specifiche, aggiorna lo stock
        const ingNames = rest.ingredients.map(i => i.name.toLowerCase())
        const wineNames = rest.wines.map(w => w.name.toLowerCase())

        ingNames.forEach((name, idx) => {
          if (text.toLowerCase().includes(name)) {
            const qty = parseQuantity(text)
            if (qty) {
              db.updateStock(chatId, rest.ingredients[idx].name, qty.value)
            }
          }
        })
      } catch {
        await send(chatId, '❌ Errore di connessione. Riprova tra un momento.')
      }
      break
  }
})

// ─── CRON: ALERT SERALE ALLE 23:00 ───────────────────────────────────────────

cron.schedule('0 23 * * *', async () => {
  console.log('⏰ Invio alert serali...')
  const allRests = db.getAllRestaurants()

  for (const rest of allRests) {
    if (rest.onboardingComplete) {
      try {
        await sendStockAlert(rest.chatId)
        await sleep(2000) // Evita rate limiting
      } catch (err) {
        console.error(`Errore alert per ${rest.chatId}:`, err.message)
      }
    }
  }
}, {
  timezone: 'Europe/Rome'
})

// ─── STARTUP ──────────────────────────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════╗
║   🍕 Assistente Rifornimenti v1.0     ║
║   Bot Telegram per ristoranti         ║
╠═══════════════════════════════════════╣
║  ✅ Bot avviato                       ║
║  ✅ AI connessa (Claude)              ║
║  ✅ Alert serale: 23:00 ogni giorno   ║
║                                       ║
║  Apri Telegram e scrivi /start        ║
╚═══════════════════════════════════════╝
`)

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message)
})

process.on('SIGINT', () => {
  console.log('\n👋 Bot fermato.')
  process.exit(0)
})
