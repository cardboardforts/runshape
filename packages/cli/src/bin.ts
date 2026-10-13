// The executable: always runs, however it's invoked (node_modules/.bin links to it).
import { main } from "./main";

process.exitCode = await main(process.argv.slice(2));
