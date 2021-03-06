/// Deps
require('babel-polyfill')
const crypto = require('crypto')
const Encryption = require('./encryption')
const converter = require('@iota/converter')
const { composeAPI } = require('@iota/core')
const { createHttpClient } = require('@iota/http-client')
const { createContext, Reader, Mode } = require('../lib/mam')

// Setup Provider
let provider = null;
let Mam = {}

/**
 * Initialisation function which returns a state object
 * @param  {object} externalIOTA
 * @param  {string} seed
 * @param  {integer} security
 */
const init = (externalProvider, seed = keyGen(81), security = 2) => {
    // Set IOTA provider
    provider = externalProvider

    // Setup Personal Channel
    const channel = {
        side_key: null,
        mode: 'public',
        next_root: null,
        security,
        start: 0,
        count: 1,
        next_count: 1,
        index: 0
    }

    return {
        subscribed: [],
        channel,
        seed
    }
}
/**
 * Add a subscription to your state object
 * @param  {object} state
 * @param  {string} channelRoot
 * @param  {string} channelKey
 */
const subscribe = (state, channelRoot, channelKey = null) => {
    state.subscribed[channelRoot] = {
        channelKey,
        timeout: 5000,
        root: channelRoot,
        next_root: null,
        active: true
    }
    return state
}

const changeMode = (state, mode, sidekey) => {
    if (mode !== 'public' && mode !== 'private' && mode !== 'restricted') {
        return console.log('Did not recognise mode!')
    }
    if (mode === 'restricted' && !sidekey) {
        return console.log(
            'You must specify a side key for a restricted channel'
        )
    }
    if (sidekey) {
      state.channel.side_key = typeof sidekey === 'string' ? sidekey.padEnd(81, '9') : sidekey
    }
    state.channel.mode = mode
    return state
}

/**
 * create
 * @param  {object} state
 * @param  {sting} message // Tryte encoded string
 */
const create = (state, message) => {
    const channel = state.channel
    // Interact with MAM Lib
    const mam = Mam.createMessage(state.seed, message, channel.side_key, channel)

    // If the tree is exhausted.
    if (channel.index === channel.count - 1) {
        // change start to begining of next tree.
        channel.start = channel.next_count + channel.start
        // Reset index.
        channel.index = 0
    } else {
        // Else step the tree.
        channel.index++
    }

    // Advance Channel
    channel.next_root = mam.next_root
    state.channel = channel

    // Generate attachement address
    let address
    if (channel.mode !== 'public') {
        address = converter.trytes(
            Encryption.hash(81, converter.trits(mam.root.slice()))
        )
    } else {
        address = mam.root
    }

    return {
        state,
        payload: mam.payload,
        root: mam.root,
        address
    }
}

// Current root
const getRoot = state => Mam.getMamRoot(state.seed, state.channel)

const decode = (payload, sidekey, root) => {
    const key = typeof sidekey === 'string' ? sidekey.padEnd(81, '9') : sidekey
    Mam.decodeMessage(payload, key, root)
}

const fetch = async (root, selectedMode, sidekey, callback) => {
    let client = createHttpClient({ provider })
    let ctx = await createContext()
    const messages = []
    const mode = selectedMode === 'public' ? Mode.Public : Mode.Old
    let hasMessage = false
    let nextRoot = root

    try {
        do {
            let reader = new Reader(ctx, client, mode, nextRoot, sidekey || '')
            const message = await reader.next()
            hasMessage = message && message.value && message.value[0]
            if (hasMessage) {
                nextRoot = message.value[0].message.nextRoot
                const payload = message.value[0].message.payload

                // Push payload into the messages array
                messages.push(payload)

                // Call callback function if provided
                if (callback) {
                    callback(payload)
                }
            }
        } while(!!hasMessage)
        return { messages, nextRoot }
    } catch (e) {
        return console.error('failed to parse: ', e)
        return e
    }
}

const fetchSingle = async (root, mode, sidekey, rounds = 81) => {
    let address = root
    if (mode === 'private' || mode === 'restricted') {
        address = hash(root, rounds)
    }
    const { findTransactions } = composeAPI({ provider })
    const hashes = await findTransactions({
        addresses: [address]
    })

    const messagesGen = await txHashesToMessages(hashes)
    for (let message of messagesGen) {
        try {
            // Unmask the message
            const { payload, next_root } = decode(message, sidekey, root)
            // Return payload
            return { payload, nextRoot: next_root }
        } catch (e) {
            console.error('failed to parse: ', e)
        }
    }
}

const listen = (channel, callback) => {
    let root = channel.root
    return setTimeout(async () => {
        let resp = await fetch(root)
        root = resp.nextRoot
        callback(resp.messages)
    }, channel.timeout)
}

// Parse bundles and
const txHashesToMessages = async hashes => {
    const bundles = {}

    const processTx = txo => {
        const bundle = txo.bundle
        const msg = txo.signatureMessageFragment
        const idx = txo.currentIndex
        const maxIdx = txo.lastIndex

        if (bundle in bundles) {
            bundles[bundle].push([idx, msg])
        } else {
            bundles[bundle] = [[idx, msg]]
        }

        if (bundles[bundle].length == maxIdx + 1) {
            let l = bundles[bundle]
            delete bundles[bundle]
            return l
                .sort((a, b) => b[0] < a[0])
                .reduce((acc, n) => acc + n[1], '')
        }
    }
    const { getTransactionObjects } = composeAPI({ provider })
    const objs = await getTransactionObjects(
        hashes
    )
    return objs
        .map(result => processTx(result))
        .filter(item => item !== undefined)
}

const attach = async (trytes, root, depth = 3, mwm = 9) => {
    const transfers = [
        {
            address: root,
            value: 0,
            message: trytes
        }
    ]
    try {
        const { prepareTransfers, sendTrytes } = composeAPI({ provider })

        const trytes = await prepareTransfers('9'.repeat(81), transfers, {})

        return sendTrytes(trytes, depth, mwm);
    } catch (e) {
       	throw `failed to attach message: ${e}`
    }
}

// Helpers
const hash = (data, rounds) => {
    return converter.trytes(
        Encryption.hash(
            rounds || 81,
            converter.trits(data.slice())
        ).slice()
    )
}

const keyGen = length => {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ9'
    let key = '';
    while (key.length < length) {
        let byte = crypto.randomBytes(1)
        if (byte[0] < 243) {
            key += charset.charAt(byte[0] % 27);
        }
    }
    return key;
}

const setupEnv = rustBindings => (Mam = rustBindings)

const setIOTA = (externalProvider = null) => (provider = externalProvider)

module.exports = {
    init,
    subscribe,
    changeMode,
    create,
    decode,
    fetch,
    fetchSingle,
    attach,
    listen,
    getRoot,
    setIOTA,
    setupEnv
}
