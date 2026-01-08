///<reference path="../rpos.d.ts"/>

import parser = require('body-parser');
import { Utils } from './utils';
import EventService = require('../services/event_service');

var utils = Utils.utils;

type EventStatusSection = {
  [name: string]: boolean;
};

interface EventStatus {
  inputs: EventStatusSection;
  outputs: EventStatusSection;
  motionDetection: boolean;
  cellMotionDetection: boolean;
  lastUpdated: Date;
}

class Events {
  config: rposConfig;
  webserver: any;
  eventService: EventService;
  status: EventStatus;

  constructor(config: rposConfig, webserver: any, eventService: EventService) {
    this.config = config;
    this.webserver = webserver;
    this.eventService = eventService;
    this.status = {
      inputs: {
        Input1: false,
        Input2: false
      },
      outputs: {
        Output1: false,
        Output2: false
      },
      motionDetection: false,
      cellMotionDetection: false,
      lastUpdated: new Date()
    };

    this.setupRoutes();
  }

  setupRoutes() {
    utils.log.info("Starting events status webserver on http://%s:%s/events", utils.getIpAddress(), this.config.ServicePort);
    this.webserver.use(parser.urlencoded({ extended: true }));
    this.webserver.get('/events', (req, res) => {
      res.send(this.renderPage());
    });
    this.webserver.post('/events', (req, res) => {
      this.handleUpdate(req.body || {});
      res.send(this.renderPage());
    });
  }

  handleUpdate(body: any) {
    var updated = false;
    updated = this.updateSection(body, 'input', this.status.inputs, 'tns1:Device/Trigger') || updated;
    updated = this.updateSection(body, 'output', this.status.outputs, 'tns1:Device/Output') || updated;

    if (body.action === 'trigger-motion') {
      this.status.motionDetection = true;
      this.eventService.publishSimpleEvent('tns1:RuleEngine/Motion', [
        { Name: 'Motion', Value: true }
      ]);
      updated = true;
    } else if (body.action === 'clear-motion') {
      this.status.motionDetection = false;
      this.eventService.publishSimpleEvent('tns1:RuleEngine/Motion', [
        { Name: 'Motion', Value: false }
      ]);
      updated = true;
    }

    if (body.action === 'trigger-cell-motion') {
      this.status.cellMotionDetection = true;
      this.eventService.publishSimpleEvent('tns1:RuleEngine/CellMotionDetector/Motion', [
        { Name: 'CellMotion', Value: true }
      ]);
      updated = true;
    } else if (body.action === 'clear-cell-motion') {
      this.status.cellMotionDetection = false;
      this.eventService.publishSimpleEvent('tns1:RuleEngine/CellMotionDetector/Motion', [
        { Name: 'CellMotion', Value: false }
      ]);
      updated = true;
    }

    if (updated) {
      this.status.lastUpdated = new Date();
    }
  }

  updateSection(body: any, prefix: string, section: EventStatusSection, topic: string): boolean {
    var updated = false;
    for (var key in section) {
      var fieldName = prefix + '_' + key;
      var newValue = body[fieldName] === 'true';
      if (newValue !== section[key]) {
        section[key] = newValue;
        this.eventService.publishSimpleEvent(topic, [
          { Name: key, Value: newValue }
        ]);
        updated = true;
      }
    }
    return updated;
  }

  renderPage(): string {
    var html = "<!DOCTYPE html>";
    html += "<html><head><title>RPOS Events</title>";
    html += "<style>body{font-family:Arial, sans-serif;margin:20px;}h1{margin-bottom:10px;}fieldset{margin-bottom:15px;}label{display:block;margin:4px 0;}button{margin-right:6px;margin-top:6px;}</style>";
    html += "</head><body>";
    html += "<h1>RPOS Events</h1>";
    html += "<p>Update live event states and trigger test notifications.</p>";
    html += "<p><strong>Last Updated:</strong> " + this.status.lastUpdated.toISOString() + "</p>";
    html += "<form method=\"post\" action=\"/events\">";
    html += this.renderSection('Inputs', 'input', this.status.inputs);
    html += this.renderSection('Outputs', 'output', this.status.outputs);
    html += "<fieldset><legend>Motion Detection</legend>";
    html += "<p>Status: " + (this.status.motionDetection ? "Active" : "Inactive") + "</p>";
    html += "<button type=\"submit\" name=\"action\" value=\"trigger-motion\">Trigger Motion</button>";
    html += "<button type=\"submit\" name=\"action\" value=\"clear-motion\">Clear Motion</button>";
    html += "</fieldset>";
    html += "<fieldset><legend>Cell Motion Detection</legend>";
    html += "<p>Status: " + (this.status.cellMotionDetection ? "Active" : "Inactive") + "</p>";
    html += "<button type=\"submit\" name=\"action\" value=\"trigger-cell-motion\">Trigger Cell Motion</button>";
    html += "<button type=\"submit\" name=\"action\" value=\"clear-cell-motion\">Clear Cell Motion</button>";
    html += "</fieldset>";
    html += "<button type=\"submit\">Update Status</button>";
    html += "</form>";
    html += "</body></html>";
    return html;
  }

  renderSection(title: string, prefix: string, section: EventStatusSection): string {
    var html = "<fieldset><legend>" + title + "</legend>";
    for (var key in section) {
      var fieldName = prefix + '_' + key;
      html += "<label>";
      html += "<input type=\"hidden\" name=\"" + fieldName + "\" value=\"false\" />";
      html += "<input type=\"checkbox\" name=\"" + fieldName + "\" value=\"true\"" + (section[key] ? " checked" : "") + " /> ";
      html += key + "</label>";
    }
    html += "</fieldset>";
    return html;
  }
}

export = Events;
