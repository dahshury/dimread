import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("docs/*", "routes/docs.tsx"),
	// Pre-rendered by `react-router.config.ts` into a static Orama index —
	// GitHub Pages cannot execute a search handler at request time.
	route("api/search", "routes/search.ts"),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
