import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Callout } from "fumadocs-ui/components/callout";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Downloads } from "./downloads";
import { Combo, Kbd } from "./kbd";
import { Screenshot } from "./screenshot";

/**
 * The MDX vocabulary, registered once and passed to every page — there is no
 * `mdx-components.tsx` auto-discovery outside Next.js.
 *
 * Kept deliberately small. Nine components plus Fumadocs' defaults covers the
 * whole site; a component zoo is what makes docs drift.
 */
export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		Accordion,
		Accordions,
		Callout,
		Combo,
		Downloads,
		Kbd,
		Screenshot,
		Step,
		Steps,
		Tab,
		Tabs,
		...components,
	} satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
