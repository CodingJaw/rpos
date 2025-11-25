///<reference path="../rpos.d.ts" />

import express = require('express');
import { Utils } from '../lib/utils';

const utils = Utils.utils;

type SimpleItem = { Name: string; Value: string | number | boolean };

type EventMessage = {
  topic: string;
  sourceItems?: SimpleItem[];
  dataItems?: SimpleItem[];
};

const DIGITAL_INPUT_COUNT = 4;
const RELAY_OUTPUT_COUNT = 4;

const SOAP_NAMESPACES = [
  'xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"',
  'xmlns:SOAP-ENC="http://www.w3.org/2003/05/soap-encoding"',
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
  'xmlns:tns1="http://www.onvif.org/ver10/topics"',
  'xmlns:wsa5="http://www.w3.org/2005/08/addressing"',
  'xmlns:tev="http://www.onvif.org/ver10/events/wsdl"',
  'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"',
  'xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"',
  'xmlns:tt="http://www.onvif.org/ver10/schema"'
];

const TOPIC_SET_XML = `
    <tev:GetEventPropertiesResponse>
      <tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>
      <wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>
      <wstop:TopicSet>
        <tns1:Device>
          <Trigger>
            <DigitalInput wstop:topic="true">
              <tt:MessageDescription IsProperty="true">
                <tt:Source>
                  <tt:SimpleItemDescription Name="InputToken" Type="tt:ReferenceToken" />
                </tt:Source>
                <tt:Data>
                  <tt:SimpleItemDescription Name="LogicalState" Type="xsd:boolean" />
                </tt:Data>
              </tt:MessageDescription>
            </DigitalInput>
          </Trigger>
          <Relay wstop:topic="true">
            <tt:MessageDescription IsProperty="true">
              <tt:Source>
                <tt:SimpleItemDescription Name="RelayToken" Type="tt:ReferenceToken" />
              </tt:Source>
              <tt:Data>
                <tt:SimpleItemDescription Name="LogicalState" Type="xsd:boolean" />
              </tt:Data>
            </tt:MessageDescription>
          </Relay>
        </tns1:Device>
        <tns1:VideoSource>
          <MotionAlarm wstop:topic="true">
            <tt:MessageDescription IsProperty="true">
              <tt:Source>
                <tt:SimpleItemDescription Name="Source" Type="tt:ReferenceToken" />
              </tt:Source>
              <tt:Data>
                <tt:SimpleItemDescription Name="State" Type="xsd:boolean" />
              </tt:Data>
            </tt:MessageDescription>
          </MotionAlarm>
        </tns1:VideoSource>
      </wstop:TopicSet>
      <wsnt:TopicExpressionDialect>http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet</wsnt:TopicExpressionDialect>
      <wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete</wsnt:TopicExpressionDialect>
      <tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect>
      <tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation>
    </tev:GetEventPropertiesResponse>`;

class EventsService {
  private config: rposConfig;
  private app: express.Express;
  private queue: EventMessage[] = [];
  private subscriptionPath: string;

  constructor(config: rposConfig, app: express.Express) {
    this.config = config;
    this.app = app;
    this.subscriptionPath = '/onvif/events_pullpoint';
  }

  start() {
    this.app.post(
      '/onvif/events_service',
      express.text({ type: ['application/soap+xml', 'text/xml', '*/*'] }),
      (req, res) => this.handleSoapRequest(req.body || '', res)
    );

    this.app.post('/internal/motion', express.json(), (req, res) => {
      const active = req.body && req.body.active !== undefined ? !!req.body.active : true;
      this.enqueueEvent('tns1:VideoSource/MotionAlarm', [], [
        { Name: 'State', Value: active }
      ]);
      res.json({ status: 'ok', event: 'motion', active });
    });

    this.app.post('/internal/input/:id', express.json(), (req, res) => {
      const inputId = parseInt(req.params.id || '1', 10);
      const active = req.body && req.body.active !== undefined ? !!req.body.active : true;
      if (!this.isValidInput(inputId)) {
        res.status(400).json({ status: 'error', message: `Input ${req.params.id} out of range` });
        return;
      }
      this.enqueueEvent('tns1:Device/Trigger/DigitalInput', [
        { Name: 'InputToken', Value: `${inputId}` }
      ], [
        { Name: 'LogicalState', Value: active }
      ]);
      res.json({ status: 'ok', event: 'input', input: inputId, active });
    });

    this.app.post('/internal/input/:id/active', (req, res) => {
      const inputId = parseInt(req.params.id || '1', 10);
      if (!this.isValidInput(inputId)) {
        res.status(400).json({ status: 'error', message: `Input ${req.params.id} out of range` });
        return;
      }
      this.enqueueEvent('tns1:Device/Trigger/DigitalInput', [
        { Name: 'InputToken', Value: `${inputId}` }
      ], [
        { Name: 'LogicalState', Value: true }
      ]);
      res.json({ status: 'ok', event: 'input', input: inputId });
    });

    this.app.post('/internal/relay/:id/on', (req, res) => {
      const relayId = parseInt(req.params.id || '1', 10);
      if (!this.isValidRelay(relayId)) {
        res.status(400).json({ status: 'error', message: `Relay ${req.params.id} out of range` });
        return;
      }
      this.enqueueEvent('tns1:Device/Relay', [
        { Name: 'RelayToken', Value: `${relayId}` }
      ], [
        { Name: 'LogicalState', Value: true }
      ]);
      res.json({ status: 'ok', event: 'relay', relay: relayId });
    });

    utils.log.info('events_service started');
  }

  private handleSoapRequest(body: string, res: express.Response) {
    const content = body.toString();
    let response = '';

    if (content.indexOf('GetEventProperties') >= 0) {
      response = this.wrapResponse(
        TOPIC_SET_XML,
        'http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesResponse'
      );
    } else if (content.indexOf('CreatePullPointSubscription') >= 0) {
      response = this.wrapResponse(
        this.buildSubscriptionResponse(),
        'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionResponse'
      );
    } else if (content.indexOf('PullMessages') >= 0) {
      response = this.wrapResponse(
        this.buildPullMessagesResponse(),
        'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesResponse'
      );
    } else if (content.indexOf('GetServiceCapabilities') >= 0) {
      response = this.wrapResponse(
        '<tev:GetServiceCapabilitiesResponse><tev:Capabilities/></tev:GetServiceCapabilitiesResponse>',
        'http://www.onvif.org/ver10/events/wsdl/EventPortType/GetServiceCapabilitiesResponse'
      );
    }

    if (response) {
      res.type('application/soap+xml');
      res.send(response);
    } else {
      res.status(400).send('Unknown SOAP action');
    }
  }

  private wrapResponse(body: string, action: string) {
    const namespaces = SOAP_NAMESPACES.join(' ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope ${namespaces}>
  <SOAP-ENV:Header>
    <wsa5:Action SOAP-ENV:mustUnderstand="true">${action}</wsa5:Action>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
${body}
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
  }

  private buildSubscriptionResponse() {
    const now = new Date();
    const termination = new Date(now.getTime() + 10 * 60 * 1000);
    const address = `http://${utils.getIpAddress()}:${this.config.ServicePort}${this.subscriptionPath}`;
    return `    <tev:CreatePullPointSubscriptionResponse>
      <tev:SubscriptionReference>
        <wsa5:Address>${address}</wsa5:Address>
      </tev:SubscriptionReference>
      <wsnt:CurrentTime>${now.toISOString()}</wsnt:CurrentTime>
      <wsnt:TerminationTime>${termination.toISOString()}</wsnt:TerminationTime>
    </tev:CreatePullPointSubscriptionResponse>`;
  }

  private buildPullMessagesResponse() {
    const now = new Date();
    const termination = new Date(now.getTime() + 5 * 60 * 1000);
    const notifications = this.flushQueue()
      .map((event) => this.serializeNotification(event, now))
      .join('');

    return `    <tev:PullMessagesResponse>
      <tev:CurrentTime>${now.toISOString()}</tev:CurrentTime>
      <tev:TerminationTime>${termination.toISOString()}</tev:TerminationTime>
${notifications}
    </tev:PullMessagesResponse>`;
  }

  private serializeNotification(event: EventMessage, timestamp: Date) {
    const subscriptionAddress = `http://${utils.getIpAddress()}:${this.config.ServicePort}${this.subscriptionPath}`;
    const sourceItems = (event.sourceItems || [])
      .map((item) => `<tt:SimpleItem Name="${item.Name}" Value="${item.Value}"/>`)
      .join('');
    const dataItems = (event.dataItems || [])
      .map((item) => `<tt:SimpleItem Name="${item.Name}" Value="${item.Value}"/>`)
      .join('');

    return `      <wsnt:NotificationMessage>
        <wsnt:SubscriptionReference>
          <wsa5:Address>${subscriptionAddress}</wsa5:Address>
        </wsnt:SubscriptionReference>
        <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">
          ${event.topic}
        </wsnt:Topic>
        <wsnt:Message>
          <tt:Message UtcTime="${timestamp.toISOString()}">
            <tt:Source>${sourceItems}</tt:Source>
            <tt:Data>${dataItems}</tt:Data>
          </tt:Message>
        </wsnt:Message>
      </wsnt:NotificationMessage>`;
  }

  private enqueueEvent(topic: string, sourceItems: SimpleItem[], dataItems: SimpleItem[]) {
    this.queue.push({ topic, sourceItems, dataItems });
  }

  private flushQueue() {
    const messages = this.queue.slice();
    this.queue = [];
    return messages;
  }

  private isValidInput(inputId: number) {
    return Number.isInteger(inputId) && inputId >= 1 && inputId <= DIGITAL_INPUT_COUNT;
  }

  private isValidRelay(relayId: number) {
    return Number.isInteger(relayId) && relayId >= 1 && relayId <= RELAY_OUTPUT_COUNT;
  }
}

export = EventsService;
