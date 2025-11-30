// This file is generated manually to expose ONVIF event operations
var NOT_IMPLEMENTED = {
  Fault: {
    Code: {
      Value: "soap:client"
    },
    Reason: {
      Text: "Method not implemented"
    }
  }
};
var exports = module.exports = {};

exports.EventsService = {
  EventsService: {
    EventPort: {
      GetServiceCapabilities: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      CreatePullPointSubscription: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      GetEventProperties: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      AddEventBroker: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      DeleteEventBroker: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      GetEventBrokers: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
    },
    PullPointSubscription: {
      PullMessages: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      Seek: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      SetSynchronizationPoint: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      Unsubscribe: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; }
    },
    SubscriptionManager: {
      Renew: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; },
      Unsubscribe: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; }
    },
    NotificationProducer: {
      Subscribe: function(args /*, cb, headers*/) { throw NOT_IMPLEMENTED; }
    }
  }
};
