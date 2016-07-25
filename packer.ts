/// <reference path="d/node.d.ts"/>
/// <reference path="d/ramda.d.ts"/>
/// <reference path="d/es6-shim.d.ts"/>

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import {indexOf, groupBy, sortBy, last, uniq, memoize} from "ramda";
import {Optional, List, Jsonable, makePromise} from "./m/types";

let esprima = require("esprima");
let estraverse = require("estraverse");

let AWS = require("aws-sdk");
AWS.config.region = "ap-northeast-1";
let awsLambda = new AWS.Lambda();

function catOptionals<T>(list: Optional<T>[]): T[] {
    return list.filter(i => i.is_present()).map(i => i.get());
}
function included<T>(target:T, list: T[]) {
    return indexOf(target, list) != -1;
}

function requires(code: string): string[] {
    let ast = esprima.parse(code);
    let requires: string[] = [];
    estraverse.traverse(ast, {
        enter: node => {
            if (node.type == "CallExpression" && node.callee.name == "require") {
                if (node.arguments > 1) {
                    throw "require 的參數大於 1";
                }
                if (node.arguments[0].type != "Literal") {
                    throw "require 的參數解析失敗";
                }
                requires.push(node.arguments[0].value);
            }
        }
    });
    return requires;
}

class Module {
    static excludes = ["node_modules/aws-sdk", "node_modules/imagemagick"];
    path: string;
    constructor(mpath: string) {
        this.path = path.relative(".", mpath);
    }
    static genByJsCode(file: string): Module[] {
        let dir = path.dirname(file);
        let reqs: Optional<Module>[] = requires(fs.readFileSync(file, "utf-8"))
        .map(req => {
            let js = path.resolve(dir, `${req}.js`);
            let mo = path.resolve(`node_modules/${req}`);
            if(fs.existsSync(js)) {
                return Optional.of(new Module(js));
            } else if (fs.existsSync(mo)) {
                return Optional.of(new Module(mo));
            } else {                     // 例如 fs, path 這些內建的 node modules
                return Optional.empty();
            }
        });
        return catOptionals(reqs).filter(m => ! included(m.path, Module.excludes));
    }
    static genByNodeMoudle(dir: string): Module[] {
        function findDep(dir: string, depName: string) {
            if (fs.existsSync(path.join(dir, depName))) {
                return path.join(dir, depName);
            } else {
                return findDep(path.resolve(dir, "../.."), depName);
            }
        }
        let setting = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf-8"));
        return Object.keys(setting["dependencies"])
            .map(d => findDep(path.join(dir, "node_modules"), d))
            .map(m => new Module(m))
            .filter(m => !included(m.path, Module.excludes));
    }
    get isJs() {
        return this.path.endsWith(".js");
    }
    get dependencies(): Module[] {
        let deps: Module[];
        if (this.isJs) {
            deps = Module.genByJsCode(this.path);
        } else {
            deps = Module.genByNodeMoudle(this.path);
        }
        return uniq(deps.concat(List.of(deps).chain(d => d.dependencies).map(i => i)));
    }
}

class Lambda {
    name: string;
    constructor(name: string) {
        this.name = name;
    }
    get js() {
        return this.name + ".js";
    }
    get zip() {
        return this.name + ".zip";
    }
    get code() {
        return fs.readFileSync(this.js, "utf-8");
    }
    get dependencies() {
        return new Module(path.resolve(".", this.js)).dependencies;
    }
    get jsFiles() {
        return [this.js].concat(this.dependencies.filter(d => d.isJs).map(d => d.path));
    }
}

type LogRec = {path: string, mtime: number};
class Log {
    path: string;
    mtime: Date;
    constructor(path: string, mtime: Date) {
        this.path = path;
        this.mtime = mtime;
    }
    jsonable(): LogRec {
        return {path: this.path, mtime: this.mtime.getTime()};
    }
    static restore(data: LogRec) {
        return new Log(data.path, new Date(data.mtime));
    }
    static make(path: string): Log {
        return new Log(path, fs.statSync(path).mtime);
    }
    static load(file: string) {
        if (fs.existsSync(file)) {
            return (<LogRec[]>JSON.parse(fs.readFileSync(file, 'utf-8'))).map(Log.restore);
        } else {
            return [];
        }
    }
    static save(file: string, logs: Log[]) {
        let res = JSON.stringify(Log.merge(logs).map(i => i.jsonable()));
        fs.writeFileSync(file, res, 'utf-8');
    }
    static merge(logs: Log[]): Log[] {
        function m(logs: Log[]): Optional<Log> {
            return Optional.of(last(sortBy(l => l.mtime, logs)));
        }
        let groups = groupBy(l => l.path, logs);
        return catOptionals(Object.keys(groups).map(p => m(groups[p])));
    }
}

function makeZip(lambda: Lambda): Promise<Lambda> {
    return new Promise<Lambda>((resolve, reject) => {
        console.log(`${lambda.name} zip...`);
        let all = uniq([lambda.js].concat(lambda.dependencies.map(i => i.path)));
        let output = '';
        let cmd = child_process.spawn('zip', ['-r', lambda.zip].concat(all));
        cmd.stdout.on('data', d => output = output + d);
        cmd.on('close', code => {
            if (code == 0) {
                resolve(lambda);
            } else {
                reject(`${lambda.zip} 失敗`);
            }
        });
    });
}

function upload(lambda: Lambda): Promise<Lambda> {
    if (! fs.existsSync(lambda.zip)) throw `${lambda.zip} 不存在!!`;
    return new Promise<Lambda>((resolve, reject) => {
        var params = {
            FunctionName: lambda.name,
            ZipFile: fs.readFileSync(lambda.zip)
        };
        console.log(`${lambda.zip} 上傳中...`);
        awsLambda.updateFunctionCode(params, function(err, data) {
            if (err) {
                reject(err);
            } else {
                resolve(lambda);
            }
        });
    });
}

function isTodo(lambda: Lambda, allLogs: Log[]) {
    return ! lambda.jsFiles.map(Log.make).every(i => included(i, allLogs));
}

function loadLambdas(file: string): Lambda[] {
    if (fs.existsSync(file)) {
        return (<string[]>JSON.parse(fs.readFileSync(file, "utf-8"))).map(name => new Lambda(name));
    } else {
        return []
    }
}

let loadLogs: (file: string) => Log[] = memoize((file: string): Log[] => {
    if (fs.existsSync(file)) {
        return (<Jsonable[]>JSON.parse(fs.readFileSync(file, "utf-8"))).map(Log.restore);
    } else {
        return [];
    }
});

let dir = Optional.of(process.argv[2]);
dir.map(dir => {
    process.chdir(dir);
    let todos = loadLambdas("packer.json").filter(i => isTodo(i, loadLogs("packer.log")));
    Promise.all(todos.map(i => makeZip(i).then(upload)))
    .then(lambdas => {
        let newLogs = List.of(lambdas).chain(i => i.jsFiles).map(Log.make);
        Log.save("packer.log", Log.merge(loadLogs("packer.log").concat(newLogs)));
    });
});
