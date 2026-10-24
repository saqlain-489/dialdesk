export function logWarn(scope, err, extra = {}) {
	console.warn(JSON.stringify({ level: 'warn', scope, message: err?.message ?? String(err), ...extra }));
}
export function logError(scope, err, extra = {}) {
	console.error(JSON.stringify({ level: 'error', scope, message: err?.message ?? String(err), ...extra }));
}
export function logInfo(scope, extra = {}) {
	console.log(JSON.stringify({ level: 'info', scope, ...extra }));
}
