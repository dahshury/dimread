import { RootProvider } from "fumadocs-ui/provider/react-router";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import SearchDialog from "@/components/search";
import type { Route } from "./+types/root";
import "./app.css";
import NotFound from "./routes/not-found";

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		// `suppressHydrationWarning` is required: RootProvider mounts next-themes,
		// which writes the theme class onto <html> before hydration.
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="utf-8" />
				<meta content="width=device-width, initial-scale=1" name="viewport" />
				<Meta />
				<Links />
			</head>
			<body className="flex min-h-screen flex-col">
				<RootProvider search={{ SearchDialog }}>{children}</RootProvider>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	let message = "Something went wrong";
	let details = "An unexpected error occurred.";
	let stack: string | undefined;

	if (isRouteErrorResponse(error)) {
		if (error.status === 404) {
			return <NotFound />;
		}
		message = "Error";
		details = error.statusText;
	} else if (import.meta.env.DEV && error instanceof Error) {
		details = error.message;
		stack = error.stack;
	}

	return (
		<main className="mx-auto w-full max-w-[940px] p-4 pt-16">
			<h1 className="mb-2 font-bold text-xl">{message}</h1>
			<p className="text-fd-muted-foreground">{details}</p>
			{stack ? (
				<pre className="w-full overflow-x-auto p-4 text-sm">
					<code>{stack}</code>
				</pre>
			) : null}
		</main>
	);
}
