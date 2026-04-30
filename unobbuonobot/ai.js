// ai.js — Tutte le chiamate AI del bot
const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Estrae il menu da una foto
async function extractMenuFromPhoto(imageBase64, mediaType) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageBase64 }
        },
        {
          type: 'text',
          text: `Sei un assistente per ristoranti italiani. Estrai tutti i piatti da questo menu.
Rispondi SOLO con JSON valido, nessun testo aggiuntivo:
{"piatti": [{"nome": "...", "categoria": "...", "prezzo": 0}]}
Categorie possibili: Antipasti, Primi, Pizze, Secondi, Contorni, Dolci, Bevande, Vini.
Se il prezzo non è leggibile usa null.`
        }
      ]
    }]
  })

  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim()
    return JSON.parse(text)
  } catch {
    return { piatti: [] }
  }
}

// Genera l'alert serale sulle scorte
async function generateStockAlert(restaurant) {
  const { profile, ingredients, wines, stock, weeklyUsage, orderHistory } = restaurant

  const stockInfo = ingredients.map(ing => {
    const currentStock = stock[ing.name] || ing.weeklyOrder
    const usage = weeklyUsage[ing.name]
    const avgUsage = usage && usage.length > 0
      ? Math.round(usage.reduce((a, b) => a + b, 0) / usage.length * 10) / 10
      : ing.weeklyOrder
    const daysLeft = currentStock / (avgUsage / 7)
    return { ...ing, currentStock, avgUsage, daysLeft }
  })

  const wineInfo = wines.map(wine => {
    const current = stock[wine.name] || wine.normalStock
    const daysLeft = current / (wine.weeklyAvg || 1)
    return { ...wine, current, daysLeft }
  })

  const prompt = `Sei l'assistente rifornimenti di ${profile.name || 'questo ristorante'}.

STATO SCORTE ATTUALE:
${stockInfo.map(i => `- ${i.name}: ~${i.currentStock}${i.unit} rimasti, uso medio ${i.avgUsage}${i.unit}/settimana (${Math.round(i.daysLeft)} giorni rimasti)`).join('\n')}

CANTINA:
${wineInfo.map(w => `- ${w.name}: ${w.current} bottiglie rimaste (normale: ${w.normalStock})`).join('\n')}

Genera un messaggio WhatsApp breve e diretto per il titolare del ristorante.
Usa emoji per semaforo: 🔴 = urgente (meno di 2 giorni), 🟡 = attenzione (2-4 giorni), 🟢 = ok.
Alla fine chiedi sempre: "Mando i messaggi ai fornitori? Rispondi SI per tutti o dimmi cosa cambiare."
Tono: caldo, come un assistente di fiducia. Massimo 15 righe.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  })

  return response.content[0].text
}

// Genera il messaggio al fornitore
async function generateSupplierMessage(restaurant, ingredient, quantity) {
  const supplier = restaurant.suppliers[ingredient]
  const profile = restaurant.profile

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Scrivi un messaggio WhatsApp breve e professionale per ordinare da un fornitore.
Ristorante: ${profile.name}
Fornitore: ${supplier?.name || 'Fornitore'}
Ordine: ${quantity} di ${ingredient}
Consegna: domani mattina se possibile
Tono: diretto, professionale, come si fa tra professionisti italiani.
Massimo 3 righe.`
    }]
  })

  return response.content[0].text
}

// Interpreta una risposta ambigua del ristoratore
async function interpretOwnerResponse(message, context) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Sei l'assistente di un ristorante italiano. Il titolare ha risposto al tuo alert sulle scorte.

CONTESTO: ${context}
RISPOSTA DEL TITOLARE: "${message}"

Interpreta la risposta e rispondi con JSON:
{
  "action": "confirm_all" | "partial" | "cancel" | "correction" | "question",
  "details": "spiegazione di cosa vuole fare",
  "stockCorrection": {"ingrediente": nuovoValore} // se sta correggendo una stima
}

Solo JSON valido, nessun testo aggiuntivo.`
    }]
  })

  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim()
    return JSON.parse(text)
  } catch {
    return { action: 'question', details: message }
  }
}

// Analizza foto cantina
async function analyzeCellarPhoto(imageBase64, mediaType) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageBase64 }
        },
        {
          type: 'text',
          text: `Analizza questa foto di una cantina o scaffale di vini di un ristorante italiano.
Descrivi quello che vedi: tipo di vini visibili, quantità approssimativa, organizzazione.
Se riesci a leggere delle etichette, elencale.
Rispondi in italiano, tono amichevole e professionale.
Massimo 5 righe. Poi chiedi al ristoratore di indicare i suoi 5 vini più venduti.`
        }
      ]
    }]
  })

  return response.content[0].text
}

// Risponde a domande libere del ristoratore
async function chat(message, restaurant) {
  const context = `Ristorante: ${restaurant.profile.name || 'non ancora configurato'}
Ingredienti monitorati: ${restaurant.ingredients.map(i => i.name).join(', ') || 'nessuno ancora'}
Vini monitorati: ${restaurant.wines.map(w => w.name).join(', ') || 'nessuno ancora'}
Onboarding completato: ${restaurant.onboardingComplete ? 'sì' : 'no, step: ' + restaurant.step}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Sei l'assistente rifornimenti di un ristorante italiano. Sei pratico, caldo, diretto.
Non sei un chatbot generico — sei specializzato in gestione scorte e rifornimenti.

CONTESTO RISTORANTE:
${context}

MESSAGGIO DEL TITOLARE: "${message}"

Rispondi in modo utile e conciso. Se fanno domande sulle scorte o sui fornitori, aiuta.
Se fanno domande fuori tema, reindirizza gentilmente verso la gestione del ristorante.`
    }]
  })

  return response.content[0].text
}

module.exports = {
  extractMenuFromPhoto,
  generateStockAlert,
  generateSupplierMessage,
  interpretOwnerResponse,
  analyzeCellarPhoto,
  chat
}
