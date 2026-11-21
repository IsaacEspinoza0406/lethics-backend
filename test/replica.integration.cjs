// The historical two-process flow cannot establish same-execution ownership.
// Fail before connecting or changing data. Use the isolated Jest suites.
console.error('Prueba manual omitida: no puede garantizar propiedad temporal en la misma ejecución. Use las suites Jest con integration-isolation.');
process.exitCode = 1;
