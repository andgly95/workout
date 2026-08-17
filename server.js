const express = require('express');
const mount = require('./lib/routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

mount(app);

// The reminder sender. Polls once a minute and does nothing at all until a
// device has subscribed, so a fresh checkout stays quiet. NO_PUSH=1 keeps it out
// of the test runs.
require('./lib/push').start();

const PORT = Number(process.env.PORT) || 3003;
app.listen(PORT, () => console.log(`workout listening on ${PORT}`));
