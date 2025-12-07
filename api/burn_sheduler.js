// api/burn_scheduler.js
module.exports = async (req, res) => {
    // Просто отправляем текстовый ответ, чтобы проверить, что маршрут доступен
    res.setHeader('Content-Type', 'text/plain');
    res.statusCode = 200;
    res.end('Route is OK.');
};