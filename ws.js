'use strict'

const { EventEmitter } = require('events')
const debug = require('debug')('bitfinex:ws')
const crypto = require('crypto')
const WebSocket = require('ws')
const util = require('util')

const { isSnapshot } = require('./lib/helper.js')

/**
 * Handles communitaction with Bitfinex WebSocket API.
 * @param {sting} APIKey
 * @param {string} APISecret
 * @event
 * @class
 */
const BitfinexWS = function (APIKey, APISecret) {
  EventEmitter.call(this)

  this.APIKey = APIKey
  this.APISecret = APISecret
}

util.inherits(BitfinexWS, EventEmitter)

/**
 * @type {String}
 */
BitfinexWS.prototype.WebSocketURI = 'wss://api.bitfinex.com/ws/'

BitfinexWS.prototype.open = function open () {
  this.ws = new WebSocket(this.WebSocketURI)
  this.ws.on('message', this.onMessage.bind(this))
  this.ws.on('open', this.onOpen.bind(this))
  this.ws.on('error', this.onError.bind(this))
  this.ws.on('close', this.onClose.bind(this))
}

BitfinexWS.prototype.onMessage = function (msgJSON, flags) {
  let msg

  try {
    msg = JSON.parse(msgJSON)
  } catch (e) {
    console.error('[bfx ws2 error] received invalid json')
    console.error('[bfx ws2 error]', msgJSON)
    console.trace()
    return
  }

  debug('Received message: %j', msg)
  this.emit('message', msg, flags)
  debug('Emmited message event')

  // Drop out early if channel data
  if (Array.isArray(msg) || !msg.event) {
    return this.handleChannel(msg)
  }

  if (msg.event === 'subscribed') {
    debug('Subscription report received')
    this.channelMap[msg.chanId] = msg
  } else if (msg.event === 'auth') {
    if (msg.status !== 'OK') {
      debug('Emitting \'error\' %j', msg)
      this.emit('error', msg)
      return
    }

    this.channelMap[msg.chanId] = { channel: 'auth' }
  }

  debug('Emitting \'%s\' %j', msg.event, msg)
  this.emit(msg.event, msg)
}

BitfinexWS.prototype.handleChannel = function (msg) {
  debug('Received data from a channel')

  // First element of Array is the channelId, the rest is the info.
  const channelId = msg.shift() // Pop the first element
  const event = this.channelMap[channelId]

  if (event) {
    debug('Message in \'%s\' channel', event.channel)

    if (event.channel === 'book') {
      this._processBookEvent(msg, event)
    } else if (event.channel === 'trades') {
      this._processTradeEvent(msg, event)
    } else if (event.channel === 'ticker') {
      this._processTickerEvent(msg, event)
    } else if (event.channel === 'auth') {
      this._processUserEvent(msg)
    } else {
      debug('Message in unknown channel')
    }
  }
}

BitfinexWS.prototype._processUserEvent = function (msg) {
  if (msg[0] === 'hb') {
    return debug('Received heartbeat in user channel')
  }

  const event = msg[0]
  const data = msg[1]

  if (Array.isArray(data[0])) {
    data[0].forEach((ele) => {
      debug('Emitting \'%s\' %j', event, ele)
      this.emit(event, ele)
    })
  } else if (data.length) {
    debug('Emitting \'%s\', %j', event, data)
    this.emit(event, data)
  }
}

BitfinexWS.prototype._processTickerEvent = function (msg, event) {
  if (msg[0] === 'hb') {
    debug('Received heartbeat in %s ticker channel', event.pair)
    return
  }

  if (msg.length > 9) { // Update
    // All values are numbers
    const update = {
      bid: msg[0],
      bidSize: msg[1],
      ask: msg[2],
      askSize: msg[3],
      dailyChange: msg[4],
      dailyChangePerc: msg[5],
      lastPrice: msg[6],
      volume: msg[7],
      high: msg[8],
      low: msg[9]
    }

    debug('Emitting ticker, %s, %j', event.pair, update)
    this.emit('ticker', event.pair, update)
  }
}

BitfinexWS.prototype._processTradeEvent = function (msg, event) {
  if (msg[0] === 'hb') {
    debug('Received heartbeat in %s trade channel', event.pair)
  }

  if (isSnapshot(msg)) {
    const snapshot = msg[0].map(el => ({
      seq: el[0],
      timestamp: el[1],
      price: el[2],
      amount: el[3]
    }))

    debug('Emitting trade snapshot, %s, %j', event.pair, snapshot)
    this.emit('trade', event.pair, snapshot)
    return
  }

  if (msg[0] !== 'te' && msg[0] !== 'tu') return

  // seq is a string, other payload members are nums
  const update = { seq: msg[1] }

  if (msg[0] === 'te') { // Trade executed
    update.timestamp = msg[2]
    update.price = msg[3]
    update.amount = msg[4]
  } else { // Trade updated
    update.id = msg[2]
    update.timestamp = msg[3]
    update.price = msg[4]
    update.amount = msg[5]
  }

  // See http://docs.bitfinex.com/#trades75
  debug('Emitting trade, %s, %j', event.pair, update)
  this.emit('trade', event.pair, update)
}

BitfinexWS.prototype._processBookEvent = function (msg, event) {
  if (msg[0] === 'hb') {
    debug('Received heartbeat in %s book channel', event.pair)
    return
  }

  // TODO: Maybe break this up into snapshot/normal handlers? Also trade event
  if (!isSnapshot(msg[0]) && msg.length > 2) {
    let update

    if (event.prec === 'R0') {
      update = {
        price: msg[1],
        orderId: msg[0],
        amount: msg[2]
      }
    } else {
      update = {
        price: msg[0],
        count: msg[1],
        amount: msg[2]
      }
    }

    debug('Emitting orderbook, %s, %j', event.pair, update)
    this.emit('orderbook', event.pair, update)
    return
  }

  msg = msg[0]

  if (isSnapshot(msg)) {
    const snapshot = msg.map((el) => {
      if (event.prec === 'R0') {
        return {
          orderId: el[0],
          price: el[1],
          amount: el[2]
        }
      }

      return {
        price: el[0],
        count: el[1],
        amount: el[2]
      }
    })

    debug('Emitting orderbook snapshot, %s, %j', event.pair, snapshot)
    this.emit('orderbook', event.pair, snapshot)
  }
}

BitfinexWS.prototype.close = function () {
  this.ws.close()
}

BitfinexWS.prototype.onOpen = function () {
  this.channelMap = {} // Map channels IDs to events
  this.emit('open')
}

BitfinexWS.prototype.onError = function (error) {
  this.emit('error', error)
}

BitfinexWS.prototype.onClose = function () {
  this.emit('close')
}

BitfinexWS.prototype.send = function (msg) {
  debug('Sending %j', msg)
  this.ws.send(JSON.stringify(msg))
}

/**
 * Subscribe to Order book updates. Snapshot will be sended as multiple updates.
 * Event will be emited as `PAIRNAME_book`.
 * @param  {string} pair      BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
 * @param  {string} precision Level of price aggregation (P0, P1, P2, P3).
 *                              The default is P0.
 * @param  {string} length    Number of price points. 25 (default) or 100.
 * @see http://docs.bitfinex.com/#order-books
 */
BitfinexWS.prototype.subscribeOrderBook = function (pair = 'BTCUSD', prec = 'P0', len = '25') {
  this.send({
    event: 'subscribe',
    channel: 'book',
    pair,
    prec,
    len
  })
}

/**
 * Subscribe to trades. Snapshot will be sended as multiple updates.
 * Event will be emited as `PAIRNAME_trades`.
 * @param  {string} pair BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
 * @see http://docs.bitfinex.com/#trades75
 */
BitfinexWS.prototype.subscribeTrades = function (pair = 'BTCUSD') {
  this.send({
    event: 'subscribe',
    channel: 'trades',
    pair
  })
}

/**
 * Subscribe to ticker updates. The ticker is a high level overview of the state
 * of the market. It shows you the current best bid and ask, as well as the last
 * trade price.
 *
 * Event will be emited as `PAIRNAME_ticker`.
 * @param {string} pair BTCUSD, LTCUSD or LTCBTC. Default BTCUSD
 * @see http://docs.bitfinex.com/#ticker76
 */
BitfinexWS.prototype.subscribeTicker = function (pair = 'BTCUSD') {
  this.send({
    event: 'subscribe',
    channel: 'ticker',
    pair
  })
}

/**
 * Unsubscribe to a channel.
 * @param {number} chanId ID of the channel received on `subscribed` event.
 */
BitfinexWS.prototype.unsubscribe = function (chanId) {
  this.send({
    event: 'unsubscribe',
    chanId
  })
}

/**
 * Autenticate the user. Will receive executed traded updates.
 * @see http://docs.bitfinex.com/#wallet-updates
 */
BitfinexWS.prototype.auth = function () {
  const payload = `AUTH${Date.now()}`
  const signature = crypto.createHmac('sha384', this.APISecret)
    .update(payload)
    .digest('hex')

  this.send({
    event: 'auth',
    apiKey: this.APIKey,
    authSig: signature,
    authPayload: payload
  })
}

module.exports = BitfinexWS
