// crypto.randomUUID() is available in the Workers runtime.
export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
