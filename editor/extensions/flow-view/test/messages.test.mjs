// Message producers matched to the listeners that consume them (src/poly/messages.ts), and the flow going on into them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Index, ROOT } from './helpers.mjs'

let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-messages-'))
	const outfile = join(tmp, 'messages.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'poly', 'messages.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const call = (name, recv, arg0, strings = []) => ({ name, recv, line: 1, arg0, strings })
const ann = (name, named = {}, args = []) => ({ name, full: name, named, args })

test('Java: Spring templates, by declared type or by field name', () => {
	const typed = { kafkaTemplate: 'KafkaTemplate', rabbit: 'RabbitTemplate', jms: 'JmsTemplate', bridge: 'StreamBridge', rest: 'RestTemplate' }
	const typeOf = r => typed[r.replace(/^this\./, '')]
	assert.deepEqual(m.messageSendOf('java', call('send', 'kafkaTemplate', '"orders"', ['orders', 'key']), typeOf), { keys: ['orders'], via: 'kafka' })
	assert.deepEqual(m.messageSendOf('java', call('convertAndSend', 'jms', '"mail.queue"', ['mail.queue']), typeOf), { keys: ['mail.queue'], via: 'jms' })
	assert.deepEqual(m.messageSendOf('java', call('send', 'bridge', '"orders-out-0"', ['orders-out-0']), typeOf), { keys: ['orders-out-0'], via: 'stream' })
	// Rabbit: (exchange, routingKey, msg) or (routingKey, msg); either of the first two may name the queue.
	assert.deepEqual(m.messageSendOf('java', call('convertAndSend', 'rabbit', '"x.orders"', ['x.orders', 'orders.created']), typeOf), { keys: ['x.orders', 'orders.created'], via: 'rabbit' })
	// The type is known and is not a messaging template.
	assert.equal(m.messageSendOf('java', call('send', 'rest', '"orders"', ['orders']), typeOf), undefined)
	// Unknown type: by the field's name.
	assert.deepEqual(m.messageSendOf('java', call('send', 'this.kafkaTemplate', '"orders"', ['orders'])), { keys: ['orders'], via: 'kafka' })
	assert.equal(m.messageSendOf('java', call('send', 'mailer', '"orders"', ['orders'])), undefined)
})

test('the destination is the first argument: a constant is read, a payload literal is never taken for it', () => {
	const constOf = e => ({ TOPIC: 'orders', 'Topics.PAYMENTS': 'payments' })[e]
	assert.deepEqual(m.messageSendOf('java', call('send', 'kafkaTemplate', 'TOPIC', ['key-literal']), undefined, constOf), { keys: ['orders'], via: 'kafka' })
	assert.deepEqual(m.messageSendOf('java', call('send', 'kafkaTemplate', 'Topics.PAYMENTS', []), undefined, constOf), { keys: ['payments'], via: 'kafka' })
	assert.equal(m.messageSendOf('java', call('send', 'kafkaTemplate', 'topicFor(order)', ['key-literal']), undefined, constOf), undefined)
})

test('a destination not written out in full links nowhere', () => {
	assert.equal(m.messageSendOf('java', call('send', 'kafkaTemplate', '"${app.topic}"', ['${app.topic}'])), undefined)
	assert.equal(m.messageSendOf('java', call('send', 'kafkaTemplate', '"orders-" + region', ['orders- '])), undefined)
	assert.equal(m.messageSendOf('python', call('send', 'producer', 'f"orders-{region}"', ['orders-{…}'])), undefined)
	assert.equal(m.messageSendOf('js', call('send', 'producer', '{ topic: `orders-${region}`, messages }')), undefined)
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: '"${app.topic}"' })), [])
})

test('Python: Celery and Kafka producers', () => {
	assert.deepEqual(m.messageSendOf('python', call('delay', 'send_email', 'user.id')), { keys: [], task: 'send_email', via: 'celery' })
	assert.deepEqual(m.messageSendOf('python', call('apply_async', 'tasks.send_email', 'args')), { keys: [], task: 'tasks.send_email', via: 'celery' })
	assert.deepEqual(m.messageSendOf('python', call('send_task', 'app', '"proj.tasks.add"', ['proj.tasks.add'])), { keys: ['proj.tasks.add'], via: 'celery' })
	assert.deepEqual(m.messageSendOf('python', call('send', 'self.producer', "'orders'", ['orders'])), { keys: ['orders'], via: 'kafka' })
	assert.deepEqual(m.messageSendOf('python', call('produce', 'producer', '"orders"', ['orders'])), { keys: ['orders'], via: 'kafka' })
	assert.equal(m.messageSendOf('python', call('send', 'mail', '"orders"', ['orders'])), undefined)
	assert.equal(m.messageSendOf('python', call('delay', 'get_task()', 'x')), undefined)
})

test('JS: kafkajs topic inside the options object, NestJS ClientProxy.emit', () => {
	assert.deepEqual(m.messageSendOf('js', call('send', 'this.producer', "{ topic: 'orders', messages: [{ value }] }")), { keys: ['orders'], via: 'kafka' })
	assert.deepEqual(m.messageSendOf('js', call('emit', 'this.client', "'order.created'", ['order.created'])), { keys: ['order.created'], via: 'nest' })
	assert.equal(m.messageSendOf('js', call('send', 'producer', 'payload')), undefined)
	assert.equal(m.messageSendOf('js', call('emit', 'emitter', "'x'", ['x'])), undefined)
})

test('listener keys: named topics/queues/destination, arrays, the positional value', () => {
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: '"orders"', groupId: '"g"' })), ['orders'])
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: '{"a", "b"}' })), ['a', 'b'])
	assert.deepEqual(m.listenerKeys(ann('RabbitListener', { queues: '"orders.created"' })), ['orders.created'])
	assert.deepEqual(m.listenerKeys(ann('JmsListener', { destination: '"mail.queue"' })), ['mail.queue'])
	assert.deepEqual(m.listenerKeys(ann('SqsListener', {}, ['"orders-queue"'])), ['orders-queue'])
	assert.deepEqual(m.listenerKeys(ann('EventPattern', {}, ["'order.created'"])), ['order.created'])
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topicPattern: '"orders.*"' }, ['topicPattern = "orders.*"'])), [])
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: 'Topics.ORDERS' })), [])
	// A constant, alone or in an array, through constOf.
	const constOf = e => ({ 'Topics.ORDERS': 'orders', AUDIT: '${app.audit}' })[e]
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: 'Topics.ORDERS' }), constOf), ['orders'])
	assert.deepEqual(m.listenerKeys(ann('KafkaListener', { topics: '{Topics.ORDERS, "refunds", AUDIT}' }), constOf), ['refunds', 'orders'])
})

test('Celery task names and matching', () => {
	assert.deepEqual(m.celeryTaskNames(ann('task', { name: '"emails.send"' }), 'worker.tasks', 'send_email'), ['emails.send'])
	assert.deepEqual(m.celeryTaskNames(ann('shared_task'), 'worker.tasks', 'add'), ['worker.tasks.add'])
	const consumers = [{ id: 'add', keys: ['worker.tasks.add'], celery: true }, { id: 'orders', keys: ['orders'] }, { id: 'orders2', keys: ['orders', 'x'] }]
	assert.deepEqual(m.matchConsumers({ keys: ['tasks.add'], via: 'celery' }, consumers).map(c => c.id), ['add'])
	// Fan-out: every listener of a topic receives it.
	assert.deepEqual(m.matchConsumers({ keys: ['orders'], via: 'kafka' }, consumers).map(c => c.id), ['orders', 'orders2'])
	// Exact names only for brokers: no suffix match.
	assert.deepEqual(m.matchConsumers({ keys: ['eu.orders'], via: 'kafka' }, consumers), [])
	// A Kafka topic never matches a Celery task by suffix.
	assert.deepEqual(m.matchConsumers({ keys: ['add'], via: 'kafka' }, consumers), [])
})

// End to end on a real index: a Spring producer reaches its @KafkaListener, a Celery `.delay` reaches its task.
const ORDER_SERVICE = `package shop;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
	private static final String TOPIC = "orders";
	private final KafkaTemplate<String, String> kafkaTemplate;

	public OrderController(KafkaTemplate<String, String> kafkaTemplate) {
		this.kafkaTemplate = kafkaTemplate;
	}

	@PostMapping("/orders")
	public void place(@RequestBody String order) {
		kafkaTemplate.send(TOPIC, "key", order);
	}

	@PostMapping("/refunds")
	public void refund(@RequestBody String order) {
		kafkaTemplate.send(Topics.REFUNDS, order);
	}

	@PostMapping("/audit")
	public void audit(@RequestBody String order) {
		kafkaTemplate.send("\${app.audit-topic}", order);
	}
}
`
const LISTENER = `package shop;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderListener {
	@KafkaListener(topics = "orders", groupId = "billing")
	public void onOrder(String order) {
		charge(order);
	}

	@KafkaListener(topics = Topics.REFUNDS)
	public void onRefund(String order) {
	}

	@KafkaListener(topics = "\${app.audit-topic}")
	public void onAudit(String order) {
	}

	private void charge(String order) {
	}
}
`
const TOPICS = `package shop;

public final class Topics {
	public static final String REFUNDS = "refunds";
}
`
const TASKS = `from celery import shared_task

@shared_task
def send_email(user_id):
    return user_id
`
const VIEWS = `from fastapi import FastAPI
from tasks import send_email

app = FastAPI()

@app.post("/signup")
def signup(user_id: int):
    send_email.delay(user_id)
    return {}
`
// A frontend calling '/orders' must not reach the listener on topic "orders" through the HTTP links.
const FRONT = `export function load() {
  return fetch('/orders');
}
`

test('the flow goes on from a send into its listener, marked as a guess', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'flow-messages-e2e-'))
	for (const [f, text] of [['java/shop/OrderController.java', ORDER_SERVICE], ['java/shop/OrderListener.java', LISTENER], ['java/shop/Topics.java', TOPICS], ['py/tasks.py', TASKS], ['py/views.py', VIEWS], ['web/api.js', FRONT]]) {
		mkdirSync(join(dir, f, '..'), { recursive: true })
		writeFileSync(join(dir, f), text)
	}
	const index = new Index(dir)
	t.after(async () => { await index.close(); rmSync(dir, { recursive: true, force: true }) })
	await index.ready
	const fns = async file => index.request('methods', join(dir, file))
	const idOf = async (file, name) => (await fns(file)).find(x => x.name.endsWith(name)).id
	const flowOf = async (file, name) => index.request('graph', await idOf(file, name))
	const message = n => n.children.filter(c => c.edgeKind === 'message')

	const place = message(await flowOf('java/shop/OrderController.java', 'place'))
	assert.deepEqual(place.map(c => [c.node.label, c.guess, c.node.kind]), [['OrderListener.onOrder', true, 'controller']])
	assert.ok(place[0].node.children.some(c => c.node.label.endsWith('charge')), 'the flow goes on inside the listener')

	// One constant on both sides.
	assert.deepEqual(message(await flowOf('java/shop/OrderController.java', 'refund')).map(c => c.node.label), ['OrderListener.onRefund'])

	// A property placeholder names no topic we can know: no link, not even to the listener with the same placeholder.
	assert.deepEqual(message(await flowOf('java/shop/OrderController.java', 'audit')), [])

	const signup = message(await flowOf('py/views.py', 'signup'))
	assert.deepEqual(signup.map(c => [c.node.label, c.guess]), [['send_email', true]])

	// No HTTP edge from a fetch to a Kafka listener whose topic reads like the path.
	const load = await flowOf('web/api.js', 'load')
	assert.deepEqual(load.children.map(c => [c.edgeKind, c.node.label]), [['http', 'OrderController.place']])

	// And back: the listener's callers include the producer, as a message guess.
	const back = await index.request('callers', await idOf('java/shop/OrderListener.java', 'onOrder'))
	assert.deepEqual(back.children.map(c => [c.node.label, c.edgeKind, c.guess]), [['OrderController.place', 'message', true]])
	const taskBack = await index.request('callers', await idOf('py/tasks.py', 'send_email'))
	assert.deepEqual(taskBack.children.map(c => [c.node.label, c.edgeKind, c.guess]), [['signup', 'message', true]])

	// Impact: changing what the listener calls reaches the HTTP endpoint that produced the message.
	const impact = await index.request('impact', await idOf('java/shop/OrderListener.java', 'charge'))
	assert.ok(impact.items.some(i => i.label.startsWith('POST /orders')), JSON.stringify(impact))
	const taskImpact = await index.request('impact', await idOf('py/tasks.py', 'send_email'))
	assert.ok(taskImpact.items.some(i => i.label.startsWith('POST /signup')), JSON.stringify(taskImpact))

	// A guess stays out of the architecture view: no class edge from the producer to the listener.
	const { calls } = await index.request('typeFacts')
	assert.deepEqual(calls.filter(c => c.fromOwner === 'OrderController' && c.toOwner === 'OrderListener'), [])
})
