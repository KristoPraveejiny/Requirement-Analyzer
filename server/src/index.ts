import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

createApp({ config }).listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT}`);
  if (!config.OPENROUTER_API_KEY) {
    console.warn("OPENROUTER_API_KEY is not set — running in MOCK mode (no AI calls).");
  } else {
    console.log(`Using OpenRouter model: ${config.OPENROUTER_MODEL}`);
  }
});
