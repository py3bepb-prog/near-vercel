// withdraw.js (или любой другой файл вашей Vercel Serverless Function)

const nearAPI = require('near-api-js');
const { send } = require('micro');
const json = require('micro').json;
const { createClient } = require('@supabase/supabase-js');
const Big = require('big.js'); // npm install big.js

// --- КОНСТАНТЫ СЕТИ И SUPABASE ---
const NETWORK_ID = 'testnet';
const NODE_URL = 'https://rpc.testnet.near.org';

// Переменные окружения Vercel
const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID;
const SENDER_ID = process.env.NEAR_SENDER_ID;
const PRIVATE_KEY = process.env.NEAR_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// --- КОНСТАНТЫ ДЛЯ ТРАНЗАКЦИЙ И ТОКЕНОВ ---
const ONE_YOCTO = BigInt(1);
const GAS_LIMIT = BigInt('30000000000000');
const MIN_STORAGE_DEPOSIT = BigInt('1250000000000000000000');
const MIN_WITHDRAWAL_AMOUNT = 10000.0; // Минимальная сумма вывода

// Точность вашего токена. ВАЖНО: ПРОВЕРЬТЕ ТОЧНОСТЬ ВАШЕГО КОНТРАКТА!
// Обычно для FT это 18, 24 или 8.
const TOKEN_DECIMALS = 18; 
const DECIMAL_BASE = BigInt(10) ** BigInt(TOKEN_DECIMALS); 

const nearConfig = {
    networkId: NETWORK_ID,
    nodeUrl: NODE_URL,
};

// --- ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return send(res, 405, { error: 'Method Not Allowed' });
    }

    if (!PRIVATE_KEY || !SENDER_ID || !TOKEN_CONTRACT_ID || !SUPABASE_SERVICE_ROLE_KEY) {
        return send(res, 500, { error: 'Server configuration error: NEAR or Supabase secrets missing.' });
    }
    
    // ====================================================
    // 1. АВТОРИЗАЦИЯ ПОЛЬЗОВАТЕЛЯ ЧЕРЕЗ JWT
    // ====================================================
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return send(res, 401, { error: 'Authorization header missing or invalid.' });
    }
    const token = authHeader.replace('Bearer ', '');
    
    // Инициализируем Supabase клиент с Service Role Key
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        }
    });

    let userId;
    let transactionId = null; 
    let originalAmount = 0; 

    try {
        const { data: userData, error: authError } = await supabase.auth.getUser(token);

        if (authError || !userData?.user) {
            console.error('JWT Verification Failed:', authError?.message);
            return send(res, 401, { error: 'Invalid or expired authentication token.' });
        }
        
        userId = userData.user.id;
        
        // Проверка верификации кошелька пользователя
        const { data: walletData, error: walletError } = await supabase
            .from('wallets')
            .select('is_verified, is_active')
            .eq('user_id', userId)
            .eq('is_active', true) // Проверяем активный кошелек
            .single();

        if (walletError || !walletData || walletData.is_verified !== true) {
            console.error('Wallet Verification Failed for user:', userId);
            return send(res, 403, { error: 'User wallet is not verified or not attached.' });
        }

    } catch (e) {
        console.error('Supabase Auth Error:', e.message);
        return send(res, 500, { error: 'Internal authentication service error.' });
    }

    // ====================================================
    // 2. ОСНОВНАЯ ЛОГИКА ВЫВОДА (С БЛОКИРОВКОЙ)
    // ====================================================
    try {
        const data = await json(req);
        const { action, receiver_id, amount } = data; // amount - дробное число (e.g., 12345.56)

        if (action !== 'transfer') {
             return send(res, 400, { error: `Action '${action}' not supported. Only 'transfer' (withdrawal) is allowed.` });
        }
        if (!receiver_id) {
            return send(res, 400, { error: 'Missing receiver_id for transfer action.' });
        }
        if (!amount) {
            return send(res, 400, { error: 'Missing required parameter: amount.' });
        }
        
        // 2.1. ПРЕОБРАЗОВАНИЕ В ЙОКТО-NEAR
        let amountYoctoString;
        try {
            const amountBig = new Big(amount);
            originalAmount = parseFloat(amountBig.toFixed(TOKEN_DECIMALS)); // Сохраняем для отката с точностью DB

            if (amountBig.lt(MIN_WITHDRAWAL_AMOUNT)) {
                 return send(res, 400, { error: `Сумма вывода должна быть не менее ${MIN_WITHDRAWAL_AMOUNT.toFixed(2)} монет.` });
            }
            
            // Преобразование: Умножаем дробное число на 10^DECIMALS и преобразуем в строку BigInt
            const amountString = amountBig.toFixed(TOKEN_DECIMALS);
            const [integerPart, fractionalPart] = amountString.split('.');

            const totalYocto = BigInt(integerPart) * DECIMAL_BASE + BigInt(fractionalPart);
            amountYoctoString = totalYocto.toString();

        } catch (e) {
            console.error('Amount conversion error:', e.message);
            return send(res, 400, { error: 'Invalid amount format or conversion error.' });
        }
        
        // --- ЭТАП 1: БЛОКИРОВКА СРЕДСТВ И СОЗДАНИЕ ЗАПИСИ (RPC-вызов) ---
        const { data: dbResult, error: dbError } = await supabase.rpc('process_withdrawal_start', {
            p_user_id: userId,
            p_amount: originalAmount,
            p_receiver_id: receiver_id,
        });

        if (dbError || dbResult.status === 'error') {
             return send(res, 400, { 
                error: dbError?.message || dbResult.message,
                details: dbError?.details
            });
        }
        
        transactionId = dbResult.transaction_id; // Сохраняем ID для завершения или отката

        // --- ЭТАП 2: ВЫПОЛНЕНИЕ NEAR-ТРАНЗАКЦИИ (ft_transfer) ---
        
        // 1. Инициализация NEAR
        const { KeyPair, keyStores, transactions } = nearAPI;
        const { InMemoryKeyStore } = keyStores;
        
        const keyPair = KeyPair.fromString(PRIVATE_KEY);
        const keyStore = new InMemoryKeyStore();
        await keyStore.setKey(NETWORK_ID, SENDER_ID, keyPair);
        
        const near = await nearAPI.connect({ ...nearConfig, keyStore });
        const account = await near.account(SENDER_ID);
        
        // 2. Формирование действий
        const actions = [];
        const actionDescription = 'Withdrawal successful (Registration checked)';
        const methodName = 'ft_transfer';
        const methodArgs = { 
            receiver_id: receiver_id, 
            amount: amountYoctoString, // Используем йокто-NEAR
            memo: 'Withdrawal from Vercel Function' 
        };
        
        // Проверка регистрации (storage_deposit)
        let isRegistered = await account.viewFunction({
            contractId: TOKEN_CONTRACT_ID,
            methodName: 'storage_balance_of',
            args: { account_id: receiver_id },
        });

        if (isRegistered === null) {
            actions.push(
                transactions.functionCall(
                    'storage_deposit',
                    { account_id: receiver_id, registration_only: true },
                    GAS_LIMIT,
                    MIN_STORAGE_DEPOSIT
                )
            );
        }
        
        // Действие 2: ft_transfer
        actions.push(
            transactions.functionCall(
                methodName,
                methodArgs,
                GAS_LIMIT,
                ONE_YOCTO
            )
        );

        // 3. Выполнение транзакции
        const nearTransactionResult = await account.signAndSendTransaction({
            receiverId: TOKEN_CONTRACT_ID,
            actions: actions,
        });

        // ПРОВЕРКА: Получаем хеш транзакции. 
        // В near-api-js хеш находится в transaction.hash
        const transactionHash = nearTransactionResult.transaction.hash; 

        // --- ЭТАП 3: ЗАВЕРШЕНИЕ (COMPLETION) ---
        const { error: completeError } = await supabase.rpc('process_withdrawal_complete', {
            p_transaction_id: transactionId,
            p_hash: transactionHash,
        });

        if (completeError) {
            console.error('Database completion error (CRITICAL WARNING):', completeError.message);
            // Если хеш не записался, возвращаем успех NEAR с предупреждением
            return send(res, 200, { 
                success: true,
                message: `Вывод успешно выполнен. Хеш: ${transactionHash}. Внимание: Ошибка записи хеша в базу данных (требуется ручная проверка).`,
                transaction_id: transactionHash 
            });
        }
        
        // 4. Успешный ответ
        return send(res, 200, {
            success: true,
            message: actionDescription,
            transaction_id: transactionHash,
        });

    } catch (e) {
        // 5. ОБРАБОТКА ОШИБОК И ОТКАТ (ROLLBACK)
        console.error('NEAR transaction failed:', e.message);

        if (transactionId) {
            // Выполняем откат только если средства были заблокированы в БД
            const { error: rollbackError } = await supabase.rpc('process_withdrawal_rollback', {
                p_transaction_id: transactionId,
                p_user_id: userId,
                p_amount: originalAmount,
            });

            if (rollbackError) {
                console.error('CRITICAL ROLLBACK ERROR:', rollbackError.message);
                return send(res, 500, { 
                    error: 'КРИТИЧЕСКАЯ ОШИБКА: Сбой NEAR-транзакции. Средства заблокированы, но не удалось выполнить откат. Пожалуйста, обратитесь в поддержку.' 
                });
            }
        }
        
        return send(res, 500, { error: `Ошибка вывода средств. Средства возвращены на ваш баланс. Детали: ${e.message}` });
    }
};