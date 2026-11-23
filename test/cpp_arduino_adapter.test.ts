import { describe, expect, it } from 'vitest';

import {
    compileArduino,
    compileCpp,
    compileValueToCpp,
    CPP_GENERATED_HEADER,
    cppFlowToNode,
    cppNodeSignature,
    mapToCppType,
} from '../vscode-extension/src/compile/cpp';
import {
    checkCppNodeCode,
    CppAdapter,
    CppAdapterError,
    cppIdentifierNames,
    cppNodeFromSignature,
    cppTopLevelBindings,
    createCppStub,
    formatCppGeneratedHeader,
    isCppGeneratedFile,
    parseCppModule,
    parseCppParams,
    replaceCppUnit,
    sourceHash,
    splitCppInclude,
} from '../vscode-extension/src/cpp_adapter';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import { portArduinoProject, portCppProject, PRELUDE } from '../vscode-extension/src/port/cpp_importer';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

describe('C++ & Arduino Language Adapter (cpp_adapter.ts)', () => {
    it('parses standard C++ functions, references, pointers, defaults, namespaces, and classes', () => {
        const source = [
            '#include <string>',
            '#include <vector>',
            '',
            'namespace telemetry {',
            '',
            'struct PacketHeader {',
            '    uint16_t id;',
            '    uint8_t flags;',
            '    bool isValid() const {',
            '        return id > 0;',
            '    }',
            '};',
            '',
            'float scaleReading(int raw, float gain = 1.25f, const std::string& unit = "V") {',
            '    (void)unit;',
            '    return static_cast<float>(raw) * gain;',
            '}',
            '',
            '} // namespace telemetry',
            '',
        ].join('\n');

        const parsed = parseCppModule(source, 'src/telemetry.cpp', 'telemetry/scaleReading');
        expect(parsed.valid).toBe(true);
        expect(parsed.diagnostics).toEqual([]);

        const structUnit = parsed.units.find(u => u.name === 'PacketHeader');
        expect(structUnit).toBeDefined();
        expect(structUnit?.kind).toBe('class');
        expect(structUnit?.signature).toBe('struct PacketHeader');

        const methodUnit = parsed.units.find(u => u.name === 'isValid');
        expect(methodUnit).toBeDefined();
        expect(methodUnit?.kind).toBe('method');
        expect(methodUnit?.parentId).toBe(structUnit?.id);
        expect(methodUnit?.qualifiedName).toBe('PacketHeader.isValid');
        expect(methodUnit?.returnAnnotation).toBe('bool');

        const fnUnit = parsed.units.find(u => u.name === 'scaleReading');
        expect(fnUnit).toBeDefined();
        expect(fnUnit?.id).toBe('telemetry/scaleReading');
        expect(fnUnit?.identity).toBe('durable');
        expect(fnUnit?.kind).toBe('function');
        expect(fnUnit?.returnAnnotation).toBe('float');
        expect(fnUnit?.params).toEqual([
            { name: 'raw', annotation: 'int', default: null, kind: 'keyword' },
            { name: 'gain', annotation: 'float', default: '1.25f', kind: 'keyword' },
            { name: 'unit', annotation: 'const std::string&', default: '"V"', kind: 'keyword' },
        ]);
        expect(fnUnit?.ranges.name.start.line).toBe(13);
    });

    it('parses Arduino .ino sketches with setup(), loop(), sensor helpers, and String references', () => {
        const sketch = [
            '#include <Arduino.h>',
            '#define LED_PIN 13',
            '#define SENSOR_PIN A0',
            '',
            'int readSensor(int pin, int samples = 4) {',
            '    long sum = 0;',
            '    for (int i = 0; i < samples; ++i) {',
            '        sum += analogRead(pin);',
            '    }',
            '    return static_cast<int>(sum / samples);',
            '}',
            '',
            'String formatTelemetry(const String& label, float voltage, uint8_t channel = 0) {',
            '    return label + ":" + String(channel) + "=" + String(voltage);',
            '}',
            '',
            'void setup() {',
            '    pinMode(LED_PIN, OUTPUT);',
            '    Serial.begin(9600);',
            '}',
            '',
            'void loop() {',
            '    int value = readSensor(SENSOR_PIN);',
            '    digitalWrite(LED_PIN, value > 512 ? HIGH : LOW);',
            '}',
            '',
        ].join('\n');

        const parsed = parseCppModule(sketch, 'sensor_node.ino', 'sensor_node/readSensor');
        expect(parsed.valid).toBe(true);
        expect(parsed.units.map(u => u.name)).toEqual(['readSensor', 'formatTelemetry', 'setup', 'loop']);

        const readSensor = parsed.units[0];
        expect(readSensor.id).toBe('sensor_node/readSensor');
        expect(readSensor.identity).toBe('durable');
        expect(readSensor.returnAnnotation).toBe('int');
        expect(readSensor.signature).toBe('int readSensor(int pin, int samples = 4)');
        expect(readSensor.params).toEqual([
            { name: 'pin', annotation: 'int', default: null, kind: 'keyword' },
            { name: 'samples', annotation: 'int', default: '4', kind: 'keyword' },
        ]);

        const formatTelemetry = parsed.units[1];
        expect(formatTelemetry.returnAnnotation).toBe('String');
        expect(formatTelemetry.params).toEqual([
            { name: 'label', annotation: 'const String&', default: null, kind: 'keyword' },
            { name: 'voltage', annotation: 'float', default: null, kind: 'keyword' },
            { name: 'channel', annotation: 'uint8_t', default: '0', kind: 'keyword' },
        ]);

        const setup = parsed.units[2];
        expect(setup.returnAnnotation).toBe('void');
        expect(setup.params).toEqual([]);
        expect(setup.signature).toBe('void setup()');

        const loop = parsed.units[3];
        expect(loop.returnAnnotation).toBe('void');
        expect(loop.params).toEqual([]);
        expect(loop.signature).toBe('void loop()');
    });

    it('reports syntax diagnostics on unbalanced braces, unclosed comments, or unclosed strings', () => {
        const unclosedBrace = 'void setup() {\n    pinMode(13, OUTPUT);\n';
        const res1 = parseCppModule(unclosedBrace, 'bad.ino');
        expect(res1.valid).toBe(false);
        expect(res1.diagnostics[0].code).toBe('cpp-syntax');

        const unclosedComment = '/* unclosed comment\nint add(int a, int b) { return a + b; }';
        const res2 = parseCppModule(unclosedComment, 'bad.cpp');
        expect(res2.valid).toBe(false);
        expect(res2.diagnostics[0].message).toContain('Unclosed block comment');

        const unclosedString = 'const char* msg = "hello\nint x = 1;';
        const res3 = parseCppModule(unclosedString, 'bad2.cpp');
        expect(res3.valid).toBe(false);
        expect(res3.diagnostics[0].message).toContain('Unclosed string literal');
    });

    it('splits #include directives and extracts identifiers and top-level bindings', () => {
        const includes = splitCppInclude('#include <Arduino.h>\n#include "sensors/bme280.h"');
        expect(includes).toEqual([
            { line: '#include <Arduino.h>', header: 'Arduino.h', system: true, binding: 'Arduino' },
            { line: '#include "sensors/bme280.h"', header: 'sensors/bme280.h', system: false, binding: 'bme280' },
        ]);

        const code = [
            '#define LED_PIN 13',
            'const int SAMPLE_COUNT = 8;',
            'using Millis = unsigned long;',
            'int compute(int x) { return x + SAMPLE_COUNT + LED_PIN; }',
        ].join('\n');

        const bindings = cppTopLevelBindings(code);
        expect(bindings.has('LED_PIN')).toBe(true);
        expect(bindings.has('SAMPLE_COUNT')).toBe(true);
        expect(bindings.has('Millis')).toBe(true);
        expect(bindings.has('compute')).toBe(true);

        const idents = cppIdentifierNames(code);
        expect(idents.has('LED_PIN')).toBe(true);
        expect(idents.has('SAMPLE_COUNT')).toBe(true);
        expect(idents.has('return')).toBe(false);
    });

    it('replaces a C++/Arduino function unit and validates freshness and signature', async () => {
        const source = [
            '#include <Arduino.h>',
            '',
            'int readSensor(int pin, int samples = 4) {',
            '    return analogRead(pin);',
            '}',
            '',
            'void setup() {',
            '}',
            '',
        ].join('\n');

        const parsed = parseCppModule(source, 'sketch.ino');
        const unit = parsed.units.find(u => u.name === 'readSensor')!;
        const replacement = [
            'int readSensor(int pin, int samples = 4) {',
            '    int acc = 0;',
            '    for (int i = 0; i < samples; ++i) acc += analogRead(pin);',
            '    return acc / samples;',
            '}',
        ].join('\n');

        const proposal = replaceCppUnit({
            source,
            path: 'sketch.ino',
            unitId: unit.id,
            expectedHash: sourceHash(source),
            replacement,
        });

        expect(proposal.proposedSource).toContain('acc += analogRead(pin);');
        expect(proposal.parsed.valid).toBe(true);
        expect(proposal.edits).toHaveLength(1);

        // Stale hash throws
        expect(() =>
            replaceCppUnit({
                source,
                path: 'sketch.ino',
                unitId: unit.id,
                expectedHash: 'sha256:0000',
                replacement,
            }),
        ).toThrow(CppAdapterError);

        // Signature mismatch throws
        expect(() =>
            replaceCppUnit({
                source,
                path: 'sketch.ino',
                unitId: unit.id,
                expectedHash: sourceHash(source),
                replacement: 'int readSensor(int pin) {\n    return 0;\n}',
            }),
        ).toThrow(/preserve the function name, signature/);

        const adapter = new CppAdapter();
        const asyncParsed = await adapter.parseModule(proposal.proposedSource, 'sketch.ino');
        expect(asyncParsed.valid).toBe(true);
        expect(adapter.isGeneratedFile( formatCppGeneratedHeader('sketch.ino'))).toBe(true);
        adapter.dispose();
    });

    it('creates valid C++ and Arduino stubs and enforces JPL-60 via checkCppNodeCode', () => {
        const stub1 = createCppStub('readSensor', [
            { name: 'pin', annotation: 'int', default: null, kind: 'keyword' },
            { name: 'samples', annotation: 'int', default: '4', kind: 'keyword' },
        ], 'int');
        expect(stub1).toContain('int readSensor(int pin, int samples = 4)');
        expect(stub1).toContain('return 0;');
        expect(checkCppNodeCode(stub1, 'readSensor').valid).toBe(true);

        const stubVoid = createCppStub('void setup()');
        expect(stubVoid).toContain('void setup()');
        expect(checkCppNodeCode(stubVoid, 'setup').valid).toBe(true);

        const stubStruct = createCppStub('SensorFrame', undefined, null, 'struct');
        expect(stubStruct).toContain('struct SensorFrame');

        const nodeFromSig = cppNodeFromSignature('float filterSample(float x, float alpha = 0.5f)', 'Low-pass filter', 'arduino');
        expect(nodeFromSig.name).toBe('filterSample');
        expect(nodeFromSig.imports).toContain('#include <Arduino.h>');
        expect(nodeFromSig.extra.arduinoSketch).toBe(true);

        // JPL-60: >60 lines fails
        const bodyLines = Array.from({ length: 62 }, (_, i) => `    x += ${i};`);
        const oversized = ['int bigFunc(int x) {', ...bodyLines, '    return x;', '}'].join('\n');
        const overCheck = checkCppNodeCode(oversized, 'bigFunc');
        expect(overCheck.valid).toBe(false);
        expect(overCheck.lineCount).toBeGreaterThan(60);
        expect(overCheck.diagnostics.some(d => d.code === 'jpl60-line-count')).toBe(true);

        // JPL-60: missing parameter type annotation fails
        const untypedParam = 'int badFunc(pin, int samples) {\n    return pin + samples;\n}';
        const paramCheck = checkCppNodeCode(untypedParam, 'badFunc');
        expect(paramCheck.valid).toBe(false);
        expect(paramCheck.diagnostics.some(d => d.code === 'jpl60-param-annotation')).toBe(true);

        // JPL-60: missing return type annotation fails
        const untypedReturn = 'badReturn(int pin) {\n    return pin;\n}';
        const returnCheck = checkCppNodeCode(untypedReturn, 'badReturn');
        expect(returnCheck.valid).toBe(false);
        expect(returnCheck.diagnostics.some(d => d.code === 'jpl60-return-annotation')).toBe(true);

        // Pointer and array parameter parsing
        const params = parseCppParams('const char* label, uint8_t buffer[16], int& count');
        expect(params).toEqual([
            { name: 'label', annotation: 'const char*', default: null, kind: 'keyword' },
            { name: 'buffer', annotation: 'uint8_t[16]', default: null, kind: 'keyword' },
            { name: 'count', annotation: 'int&', default: null, kind: 'keyword' },
        ]);
    });
});

describe('C++ & Arduino Importer & Compiler Round-Trips', () => {
    it('ports an Arduino .ino sketch into SlateNodes and compiles it back to .ino cleanly', () => {
        const sketchSource = [
            '#include <Arduino.h>',
            '#include <Wire.h>',
            '',
            '#define LED_PIN 13',
            'const int SENSOR_PIN = A0;',
            '',
            'struct Calibration {',
            '    int offset;',
            '    float scale;',
            '};',
            '',
            'int readSensor(int pin, int samples = 4) {',
            '    int total = 0;',
            '    for (int i = 0; i < samples; ++i) {',
            '        total += analogRead(pin);',
            '    }',
            '    return total / samples;',
            '}',
            '',
            'void setup() {',
            '    pinMode(LED_PIN, OUTPUT);',
            '}',
            '',
            'void loop() {',
            '    int reading = readSensor(SENSOR_PIN);',
            '    digitalWrite(LED_PIN, reading > 512 ? HIGH : LOW);',
            '}',
            '',
        ].join('\n');

        const ported = portArduinoProject({ 'thermostat.ino': sketchSource });
        expect(ported.config.language).toBe('arduino');
        expect(ported.report.modules).toEqual(['thermostat.ino']);
        expect(ported.report.preludes).toBe(1);
        expect(ported.report.nodes).toBe(4); // Calibration, readSensor, setup, loop

        const preludeNode = ported.nodes.get(`thermostat/${PRELUDE}`)!;
        expect(preludeNode).toBeDefined();
        expect(preludeNode.code.join('\n')).toContain('#define LED_PIN 13');
        expect(preludeNode.code.join('\n')).toContain('const int SENSOR_PIN = A0;');

        const loopNode = ported.nodes.get('thermostat/loop')!;
        expect(loopNode).toBeDefined();
        expect(loopNode.extra.arduinoSketch).toBe(true);
        expect(loopNode.imports).toContain('#include <Arduino.h>');
        expect(loopNode.imports).toContain('#include <Wire.h>');
        expect(loopNode.uses).toContain(`thermostat/${PRELUDE}`);
        expect(loopNode.uses).toContain('thermostat/readSensor');

        // Compile back to .ino
        const compiled = compileCpp(ported.nodes, ported.config);
        expect(compiled.diagnostics).toEqual([]);
        const outIno = compiled.files.get('thermostat.ino')!;
        expect(outIno).toBeDefined();
        expect(outIno.startsWith(CPP_GENERATED_HEADER)).toBe(true);
        expect(outIno).toContain('#include <Arduino.h>');
        expect(outIno).toContain('#include <Wire.h>');
        expect(outIno).toContain('#define LED_PIN 13');
        expect(outIno).toContain('int readSensor(int pin, int samples);');
        expect(outIno).toContain('int readSensor(int pin, int samples = 4)');
        expect(outIno).toContain('void setup()');
        expect(outIno).toContain('void loop()');

        // Re-port compiled output to verify round-trip stability
        const reported = portCppProject(compiled.files, 'arduino');
        expect(reported.report.warnings).toEqual([]);
        expect(reported.nodes.has('thermostat/readSensor')).toBe(true);
        expect(reported.nodes.has('thermostat/setup')).toBe(true);
        expect(reported.nodes.has('thermostat/loop')).toBe(true);
        expect(reported.nodes.has(`thermostat/${PRELUDE}`)).toBe(true);
    });

    it('ports multi-file standard C++ (.h + .cpp) projects and preserves cross-file includes and uses', () => {
        const files = {
            'math_utils.h': [
                '#pragma once',
                '#define DEFAULT_MIN 0',
                '#define DEFAULT_MAX 100',
                '',
                'int clampInt(int val, int lo, int hi);',
                '',
            ].join('\n'),
            'math_utils.cpp': [
                '#include "math_utils.h"',
                '',
                'int clampInt(int val, int lo, int hi) {',
                '    if (val < lo) return lo;',
                '    if (val > hi) return hi;',
                '    return val;',
                '}',
                '',
                'int clampPercent(int val) {',
                '    return clampInt(val, DEFAULT_MIN, DEFAULT_MAX);',
                '}',
                '',
            ].join('\n'),
        };

        const ported = portCppProject(files, 'cpp');
        expect(ported.config.language).toBe('cpp');
        expect(ported.nodes.has('math_utils/clampInt')).toBe(true);
        expect(ported.nodes.has('math_utils/clampPercent')).toBe(true);

        const clampPercent = ported.nodes.get('math_utils/clampPercent')!;
        expect(clampPercent.uses).toContain('math_utils/clampInt');
        expect(clampPercent.uses).toContain(`math_utils_h/${PRELUDE}`);

        const compiled = compileCpp(ported.nodes, ported.config);
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.files.has('math_utils.h')).toBe(true);
        expect(compiled.files.has('math_utils.cpp')).toBe(true);

        const cppOut = compiled.files.get('math_utils.cpp')!;
        expect(cppOut).toContain(CPP_GENERATED_HEADER);
        expect(cppOut).toContain('#include "math_utils.h"');
        expect(cppOut).toContain('int clampInt(int val, int lo, int hi);');
        expect(cppOut).toContain('int clampPercent(int val)');
    });

    it('compiles wired SlateFlows with branch, foreach, and repeat regions into C++ and Arduino sketches', () => {
        const nodes = new Map<string, SlateNode>([
            [
                'doubleVal',
                {
                    name: 'doubleVal',
                    language: 'cpp',
                    intent: 'Double input',
                    contract: 'Returns x * 2',
                    context: [],
                    examples: [],
                    locked: false,
                    imports: [],
                    uses: [],
                    code: ['int doubleVal(int item) {', '    return item * 2;', '}'],
                    extra: {},
                },
            ],
            [
                'negateVal',
                {
                    name: 'negateVal',
                    language: 'cpp',
                    intent: 'Negate input',
                    contract: 'Returns -x',
                    context: [],
                    examples: [],
                    locked: false,
                    imports: [],
                    uses: [],
                    code: ['int negateVal(int item) {', '    return -item;', '}'],
                    extra: {},
                },
            ],
            [
                'incrementStep',
                {
                    name: 'incrementStep',
                    language: 'cpp',
                    intent: 'Increment state',
                    contract: 'Returns state + step',
                    context: [],
                    examples: [],
                    locked: false,
                    imports: [],
                    uses: [],
                    code: ['int incrementStep(int state, int step = 1) {', '    return state + step;', '}'],
                    extra: {},
                },
            ],
        ]);

        const pipelineFlow: SlateFlow = {
            name: 'runPipeline',
            inputs: [
                { name: 'flag', annotation: 'bool' },
                { name: 'seed', annotation: 'int' },
                { name: 'items', annotation: 'list[int]' },
            ],
            outputs: [
                { name: 'branched', annotation: 'int' },
                { name: 'mapped', annotation: 'list[int]' },
                { name: 'repeated', annotation: 'int' },
            ],
            instances: [],
            regions: [
                {
                    id: 'branch_1',
                    kind: 'branch',
                    conditionPort: 'condition',
                    thenFlow: 'doubleVal',
                    elseFlow: 'negateVal',
                },
                {
                    id: 'foreach_1',
                    kind: 'foreach',
                    bodyFlow: 'doubleVal',
                    collectionPort: 'items',
                    itemPort: 'item',
                    maxIterations: 16,
                },
                {
                    id: 'repeat_1',
                    kind: 'repeat',
                    bodyFlow: 'incrementStep',
                    maxIterations: 5,
                    statePorts: ['state'],
                },
            ],
            wires: [
                { from: 'input:flag', to: 'branch_1.in:condition' },
                { from: 'input:seed', to: 'branch_1.in:item' },
                { from: 'input:items', to: 'foreach_1.in:items' },
                { from: 'branch_1.out', to: 'repeat_1.in:state' },
                { from: 'branch_1.out', to: 'output:branched' },
                { from: 'foreach_1.out', to: 'output:mapped' },
                { from: 'repeat_1.out', to: 'output:repeated' },
            ],
            extra: {},
        };

        const config: SlateConfig = {
            slate: 3,
            name: 'region_demo',
            language: 'cpp',
        };

        const flows = new Map<string, SlateFlow>([['runPipeline', pipelineFlow]]);
        const compiled = compileCpp(nodes, config, flows);
        expect(compiled.diagnostics).toEqual([]);

        const outCpp = compiled.files.get('region_demo.cpp')!;
        expect(outCpp).toBeDefined();
        expect(outCpp).toContain(CPP_GENERATED_HEADER);
        expect(outCpp).toContain('#include <vector>');
        expect(outCpp).toContain('#include <tuple>');
        // Branch region
        expect(outCpp).toContain('if (flag) {');
        expect(outCpp).toContain('v_branch_1 = doubleVal(seed);');
        expect(outCpp).toContain('v_branch_1 = negateVal(seed);');
        // Foreach region
        expect(outCpp).toContain('for (size_t _idx = 0; _idx < items.size(); ++_idx) {');
        expect(outCpp).toContain('if (_idx >= 16) {');
        expect(outCpp).toContain('v_foreach_1.push_back(_item_foreach_1);');
        // Repeat region
        expect(outCpp).toContain('for (int _iter = 0; _iter < 5; ++_iter) {');
        expect(outCpp).toContain('v_repeat_1 = incrementStep(v_repeat_1, 1);');
    });

    it('synthesizes setup() and loop() for Arduino sketches compiled from flows and refuses overwriting non-generated files', () => {
        const nodes = new Map<string, SlateNode>([
            [
                'blinkStep',
                {
                    name: 'blinkStep',
                    language: 'arduino',
                    intent: 'Toggle LED',
                    contract: 'Writes pin 13',
                    context: [],
                    examples: [],
                    locked: false,
                    imports: ['#include <Arduino.h>'],
                    uses: [],
                    code: ['int blinkStep(int pin) {', '    digitalWrite(pin, HIGH);', '    return pin;', '}'],
                    extra: { arduinoSketch: true },
                },
            ],
        ]);

        const mainFlow: SlateFlow = {
            name: 'main',
            inputs: [],
            outputs: [{ name: 'result', annotation: 'int' }],
            instances: [
                { id: 'pin_val', kind: 'value', value: 13 },
                { id: 'call_blink', node: 'blinkStep' },
            ],
            wires: [
                { from: 'pin_val.out', to: 'call_blink.in:pin' },
                { from: 'call_blink.out', to: 'output:result' },
            ],
            extra: {},
        };

        const config: SlateConfig = { slate: 3, name: 'auto_blink', language: 'arduino' };
        const flows = new Map<string, SlateFlow>([['main', mainFlow]]);

        const compiled = compileArduino(nodes, config, flows);
        expect(compiled.diagnostics).toEqual([]);
        const ino = compiled.files.get('auto_blink.ino')!;
        expect(ino).toBeDefined();
        expect(ino).toContain('#include <Arduino.h>');
        expect(ino).toContain('int main()');
        expect(ino).toContain('void setup()');
        expect(ino).toContain('void loop() {\n    main();\n}');

        // Refuses to overwrite hand-edited file lacking CPP_GENERATED_HEADER
        const blocked = compileArduino(nodes, config, flows, new Map(), {
            'auto_blink.ino': '// Hand-written sketch\nvoid setup() {}\nvoid loop() {}\n',
        });
        expect(blocked.files.size).toBe(0);
        expect(blocked.diagnostics.some(d => d.severity === 'error' && d.message.includes('Refusing to overwrite'))).toBe(true);

        // Helpers coverage
        expect(compileValueToCpp([1, 2, 3], false)).toBe('std::vector<int>{1, 2, 3}');
        expect(compileValueToCpp('hello', true)).toBe('String("hello")');
        expect(mapToCppType('str', true)).toBe('String');
        expect(mapToCppType('str', false)).toBe('std::string');
        expect(cppNodeSignature(nodes.get('blinkStep')!)?.name).toBe('blinkStep');
        expect(typeof cppFlowToNode).toBe('function');
    });
});
