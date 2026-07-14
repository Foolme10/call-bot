'use strict';

// Routes a campaign to the right broadcast engine by its channel. Both engines
// expose the same lifecycle interface (startCampaign / pauseCampaign /
// stopCampaign / rerunCampaign), so callers stay channel-agnostic.

const dialer = require('./dialer');
const smsSender = require('./smsSender');

function engineFor(channel) {
  return channel === 'sms' ? smsSender : dialer;
}

module.exports = { engineFor };
