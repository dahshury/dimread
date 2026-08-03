import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { PageIcon } from "@/lib/page-icons";
import { Downloads } from "./downloads";
import { Combo, Kbd } from "./kbd";
import { Screenshot } from "./screenshot";
import { Spectrum } from "./spectrum";

/**
 * The MDX vocabulary, registered once and passed to every page — there is no
 * `mdx-components.tsx` auto-discovery outside Next.js.
 *
 * Kept deliberately small. A dozen components plus Fumadocs' defaults covers
 * the whole site; a component zoo is what makes docs drift.
 */
export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		Accordion,
		Accordions,
		Callout,
		Card,
		Cards,
		Combo,
		Downloads,
		Kbd,
		PageIcon,
		Screenshot,
		Spectrum,
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
