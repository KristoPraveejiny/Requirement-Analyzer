import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

createApp({ config }).listen(config.PORT, config.HOST, () => {
  console.log(
    `Server listening on http://${config.HOST}:${config.PORT} (PORT env: ${process.env.PORT ?? "unset, using default"})`,
  );
  if (!config.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set — running in MOCK mode (no AI calls).");
  } else {
    console.log(`Using Gemini model: ${config.GEMINI_MODEL}`);
  }
});
