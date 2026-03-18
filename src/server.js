import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

// Для ESM модулей: получаем __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Парсер JSON и URL-encoded данных
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Отдаём всю папку Public как статику
app.use(express.static(path.join(__dirname, 'Public')));

// Чтобы /Dashboard работал без index.html
app.get('/Dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'Public', 'Dashboard', 'index.html'));
});

// Пример: другие маршруты API
// app.use('/api', apiRouter);

// Любые дополнительные обработчики ошибок или middleware можно добавить здесь

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
