// --- ИСПРАВЛЕННЫЙ ИМПОРТ ---
const nearAPI = require('near-api-js');
// Мы импортируем только send и json из 'micro'
const { send } = require('micro'); 
// json импортируется отдельно, так как 'micro' экспортирует его как 'json'
const json = require('micro').json; // <-- ИСПРАВЛЕНИЕ: Прямой импорт json

// --- КОНСТАНТЫ ---
const NETWORK_ID = 'testnet'; 
const NODE_URL = 'https://rpc.testnet.near.org';

// КОНСТАНТЫ ДЛЯ ТРАНЗАКЦИЙ (BigInt работает в Node.js)
const ONE_YOCTO = BigInt(1); 
const GAS_LIMIT = BigInt('30000000000000'); 
const MIN_STORAGE_DEPOSIT = BigInt('1250000000000000000000'); 

// Переменные окружения Vercel
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID; 
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;

const config = {
    networkId: NETWORK_ID, 
    nodeUrl: NODE_URL, 
};

// --- ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ ---
module.exports = async (req, res) => {
    // Проверка метода запроса
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    try {
        // 1. Парсинг тела запроса (ИСПРАВЛЕННОЕ ИСПОЛЬЗОВАНИЕ JSON)
        const data = await json(req); // <--- Теперь json доступен
        const { receiver_id, amount } = data;

        if (!receiver_id || !amount) {
            return send(res, 400, { error: 'Missing receiver_id or amount' });
        }
        
        if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID) {
             return send(res, 500, { error: 'Server configuration error: NEAR secrets or contract ID missing.' });
        }

        // 2. Инициализация NEAR в Node.js
        const { KeyPair, keyStores, transactions } = nearAPI; 
        const { InMemoryKeyStore } = keyStores;
        
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair); 
        
        const near = await nearAPI.connect({ ...config, keyStore });
        const account = await near.account(SENDER_ID); 

        // 3. Проверка регистрации и формирование действий
        const actions = [];
        
        // Проверяем, зарегистрирован ли получатель
        let isRegistered = await account.viewFunction({
            contractId: TOKEN_CONTRACT_ID,
            methodName: 'storage_balance_of',
            args: { account_id: receiver_id },
        });

        // Если null, аккаунт не зарегистрирован -> добавляем действие storage_deposit
        if (isRegistered === null) {
            console.log(`User ${receiver_id} is not registered. Adding storage_deposit action.`);
            
            // Действие 1: Регистрация (storage_deposit)
            actions.push(
                transactions.functionCall(
                    'storage_deposit',
                    { account_id: receiver_id, registration_only: true },
                    GAS_LIMIT,
                    MIN_STORAGE_DEPOSIT 
                )
            );
        }

        // Действие 2: Перевод токенов (ft_transfer)
        actions.push(
            transactions.functionCall(
                'ft_transfer',
                {
                    receiver_id: receiver_id,
                    amount: amount, 
                    memo: 'Withdrawal from Vercel Function',
                },
                GAS_LIMIT,
                ONE_YOCTO 
            )
        );

        // 4. Выполнение пакетной транзакции
        const result = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID, 
            actions: actions,
        });

        // 5. Успешный ответ
        return send(res, 200, {
            success: true,
            message: 'Withdrawal successful (Registration checked)',
            transaction_id: result.transaction.hash,
        });

    } catch (e) {
        // 6. Обработка ошибок
        console.error('NEAR Transaction Error:', e.message);
        return send(res, 500, { 
            error: 'Transaction failed', 
            details: e.message 
        });
    }
};