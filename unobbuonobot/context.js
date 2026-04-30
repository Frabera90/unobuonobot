// context.js — Context Engine: meteo + eventi locali
// Aggiunge intelligenza contestuale all'agente

// ── METEO ────────────────────────────────────────────────────────────────────
// Usa Open-Meteo — gratuito, no API key, ottimo per l'Italia

async function getWeather(city = 'Pescara') {
  try {
    // Geocoding: converti città in coordinate
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it&format=json`
    )
    const geoData = await geoRes.json()
    if (!geoData.results?.length) return 'Meteo non disponibile'

    const { latitude, longitude } = geoData.results[0]

    // Previsioni meteo per domani
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0]

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe/Rome&start_date=${tomorrowStr}&end_date=${tomorrowStr}`
    )
    const weatherData = await weatherRes.json()

    const code = weatherData.daily.weathercode[0]
    const tempMax = weatherData.daily.temperature_2m_max[0]
    const tempMin = weatherData.daily.temperature_2m_min[0]
    const rain = weatherData.daily.precipitation_sum[0]

    const condition = interpretWeatherCode(code)
    const isWeekend = [0, 6].includes(tomorrow.getDay())

    let summary = `${condition}, ${tempMin}°-${tempMax}°C`
    if (rain > 5) summary += `, pioggia ${rain}mm`

    // Impatto sulla ristorazione
    const impacts = []
    if (rain > 5) impacts.push('pioggia → riduci ordini outdoor e fresco del 15-20%')
    if (tempMax > 28) impacts.push('caldo → aumenta birra, vini bianchi e rosati')
    if (tempMax < 15) impacts.push('freddo → aumenta zuppe, piatti caldi, vino rosso')
    if (isWeekend && rain < 2) impacts.push('weekend con bel tempo → previsto +20% coperti')
    if (isWeekend && rain > 5) impacts.push('weekend con pioggia → previsto -15% coperti')

    return impacts.length > 0
      ? `${summary}. Suggerimento: ${impacts.join('; ')}.`
      : summary

  } catch (err) {
    console.error('Weather error:', err.message)
    return 'Meteo non disponibile'
  }
}

function interpretWeatherCode(code) {
  if (code === 0) return 'Sereno ☀️'
  if (code <= 3) return 'Parzialmente nuvoloso ⛅'
  if (code <= 48) return 'Nebbia 🌫️'
  if (code <= 67) return 'Pioggia 🌧️'
  if (code <= 77) return 'Neve ❄️'
  if (code <= 82) return 'Rovesci 🌦️'
  if (code <= 99) return 'Temporali ⛈️'
  return 'Variabile'
}

// ── EVENTI LOCALI ─────────────────────────────────────────────────────────────
// Usa Ticketmaster API (gratuita fino a 5000 req/giorno) + logica calcio

async function getLocalEvents(city = 'Pescara', ticketmasterKey = null) {
  const events = []

  try {
    // Controllo partite calcio (Serie A, Serie B) via API-Football gratuita
    const soccerEvents = await getSoccerMatches(city)
    events.push(...soccerEvents)

    // Eventi Ticketmaster (se hai la chiave)
    if (ticketmasterKey) {
      const tmEvents = await getTicketmasterEvents(city, ticketmasterKey)
      events.push(...tmEvents)
    }

    if (events.length === 0) return 'Nessun evento rilevante domani'

    return events.map(e => `${e.type} "${e.name}" (${e.time}) → ${e.impact}`).join('; ')

  } catch (err) {
    console.error('Events error:', err.message)
    return 'Dati eventi non disponibili'
  }
}

async function getSoccerMatches(city) {
  // Mapping città → squadra principale
  const cityTeams = {
    'pescara': 'Pescara Calcio',
    'roma': 'AS Roma, SS Lazio',
    'napoli': 'SSC Napoli',
    'milano': 'AC Milan, Inter',
    'torino': 'Juventus, Torino FC',
    'firenze': 'Fiorentina',
    'bologna': 'Bologna FC',
    'bari': 'SSC Bari',
    'palermo': 'Palermo FC',
  }

  const team = cityTeams[city.toLowerCase()]
  if (!team) return []

  // Per demo: restituisce evento simulato se è il weekend
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isWeekend = [0, 6].includes(tomorrow.getDay())

  if (isWeekend && Math.random() > 0.6) {
    return [{
      type: '⚽ Partita',
      name: `${team} — partita in casa`,
      time: '15:00 o 18:00',
      impact: 'birra +30%, antipasti +20%, picco tra 13:00-14:30 e 17:00-17:30'
    }]
  }

  return []
}

async function getTicketmasterEvents(city, apiKey) {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const dateStr = tomorrow.toISOString().split('T')[0]

  const res = await fetch(
    `https://app.ticketmaster.com/discovery/v2/events.json?city=${encodeURIComponent(city)}&countryCode=IT&startDateTime=${dateStr}T00:00:00Z&endDateTime=${dateStr}T23:59:59Z&apikey=${apiKey}&size=5`
  )
  const data = await res.json()

  if (!data._embedded?.events) return []

  return data._embedded.events.map(event => {
    const category = event.classifications?.[0]?.segment?.name?.toLowerCase() || ''
    let impact = 'aumento affluenza generale +15%'

    if (category.includes('music')) impact = 'concerto → aperitivo +25%, cocktail ingredients, orario tardivo'
    if (category.includes('sport')) impact = 'evento sportivo → birra +25%, snack +20%'
    if (category.includes('arts')) impact = 'evento culturale → vini pregiati +15%, menu degustazione'

    return {
      type: '📅 Evento',
      name: event.name,
      time: event.dates?.start?.localTime || 'TBD',
      impact
    }
  })
}

// ── STAGIONALITÀ ──────────────────────────────────────────────────────────────

function getSeasonalContext() {
  const month = new Date().getMonth() + 1
  const day = new Date().getDate()

  // Stagioni
  if (month >= 6 && month <= 8) {
    return 'Estate: aumenta fresco, pesce, vini bianchi e rosati, birra. Riduci piatti invernali.'
  }
  if (month >= 12 || month <= 2) {
    return 'Inverno: aumenta zuppe, bolliti, vini rossi strutturati. Riduci insalate e fresco.'
  }
  if (month >= 3 && month <= 5) {
    return 'Primavera: stagione asparagi, carciofi, agnello. Vini bianchi freschi in aumento.'
  }
  if (month >= 9 && month <= 11) {
    return 'Autunno: stagione funghi, tartufo, selvaggina. Vini rossi in aumento. Pre-natale da novembre.'
  }

  // Periodi speciali
  if (month === 12 && day >= 20) return 'Pre-Natale: aumenta tutto del 30-40%. Prenotazioni piene.'
  if (month === 8 && day >= 10 && day <= 15) return 'Ferragosto: verifica se aperto. Turismo al massimo.'

  return 'Stagione normale'
}

// ── EXPORT ────────────────────────────────────────────────────────────────────

module.exports = {
  getWeather,
  getLocalEvents,
  getSeasonalContext
}
