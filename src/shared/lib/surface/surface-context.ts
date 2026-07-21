import { createContext, use } from "react";

/**
 * Elevation substrate context. Split from the provider component
 * (`SurfaceProvider.tsx`) so this file exports no components: mixing hook and
 * component exports in one file breaks Fast Refresh's state preservation.
 */
export const SurfaceContext = createContext<number>(1);

export function useSurface(): number {
	return use(SurfaceContext);
}
