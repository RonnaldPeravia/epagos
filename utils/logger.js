function logStep(step, message, data = null) {

    const timestamp = new Date().toISOString();

    console.log(`\n==============================`);
    console.log(`[${timestamp}] ${step}`);
    console.log(`➡️ ${message}`);

    if (data !== null) {
        console.log("DATA:");
        console.dir(data, { depth: null });
    }

    console.log(`==============================\n`);
}

module.exports = {
    logStep
};