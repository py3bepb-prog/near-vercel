const nearAPI = require('near-api-js');
const { send } = require('micro'); 
const json = require('micro').json; 

// --- КОНСТАНТЫ СЕТИ ---
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
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID) {
         return send(res, 500, { error: 'Server configuration error: NEAR secrets or contract ID missing.' });
    }

    try {
        const data = await json(req);
        // Добавлен обязательный параметр 'action'
        const { action, receiver_id, amount } = data; 

        if (!action || !amount) {
            return send(res, 400, { error: 'Missing required parameters: action and/or amount.' });
        }

        // 1. Инициализация NEAR
        const { KeyPair, keyStores, transactions } = nearAPI; 
        const { InMemoryKeyStore } = keyStores;
        
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair); 
        
        const near = await nearAPI.connect({ ...config, keyStore });
        const account = await near.account(SENDER_ID); 

        // 2. Формирование действий
        const actions = [];
        let methodName;
        let methodArgs = { amount };
        let receiverContract = TOKEN_CONTRACT_ID;
        let actionDescription;


        if (action === 'transfer') {
            
            if (!receiver_id) {
                return send(res, 400, { error: 'Missing receiver_id for transfer action.' });
            }

            // A) Выдача (Withdrawal)
            actionDescription = 'Withdrawal successful (Registration checked)';
            methodName = 'ft_transfer';
            methodArgs = { receiver_id: receiver_id, amount: amount, memo: 'Withdrawal from Vercel Function' };
            
            // Проверка регистрации (как раньше)
            let isRegistered = await account.viewFunction({
                contractId: TOKEN_CONTRACT_ID,
                methodName: 'storage_balance_of',
                args: { account_id: receiver_id },
            });

            if (isRegistered === null) {
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
            // Действие 2: ft_transfer добавляется ниже

        } else if (action === 'burn') {
            
            // B) Сжигание (Burn)
            actionDescription = 'Token burning successful';
            methodName = 'ft_burn'; 
            // Для ft_burn обычно не нужен receiver_id, только amount
            methodArgs = { amount: amount }; 
            // Контракт, который вызываем, остается TOKEN_CONTRACT_ID

        } else {
            return send(res, 400, { error: `Action '${action}' not supported. Use 'transfer' or 'burn'.` });
        }
        
        // Добавляем основное действие (ft_transfer или ft_burn)
        actions.push(
            transactions.functionCall(
                methodName,
                methodArgs,
                GAS_LIMIT,
                methodName === 'ft_burn' ? ONE_YOCTO : ONE_YOCTO // Прикрепляем 1 yoctoNEAR
            )
        );

        // 3. Выполнение транзакции
        const result = await account.signAndSendTransaction({
            receiverId: receiverContract, 
            actions: actions,
        });

        // 4. Успешный ответ
        return send(res, 200, {
            success: true,
            message: actionDescription,
            transaction_id: result.transaction.hash,
        });

    } catch (e) {
        // 5. Обработка ошибок
        console.error('NEAR Transaction Error:', e.message);
        return send(res, 500, { 
            error: 'Transaction failed', 
            details: e.message 
        });
    }
};