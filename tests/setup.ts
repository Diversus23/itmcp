import { setLogLevel } from "../src/logger.js";

// Заглушаем INFO/WARNING/DEBUG логи в stderr, чтобы вывод тестов был чистым.
// Ассерты проверяют поведение, а не лог-сообщения.
setLogLevel("ERROR");
