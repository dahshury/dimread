import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const server = createFromSource(source, { language: "english" });

/** `staticGET`, not `GET`: the index is baked at build time (see `ssr: false`). */
export async function loader() {
	return server.staticGET();
}
