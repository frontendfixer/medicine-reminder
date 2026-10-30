import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const join = (...parts: string[]) => '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

// Every HTTP route the running app exposes, as "METHOD /path/:param", read from the controllers themselves.
export function discoverRoutes(app: INestApplication): string[] {
  const out: string[] = [];
  const controllers = [...app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
  for (const wrapper of controllers) {
    const proto = wrapper.metatype?.prototype as Record<string, unknown> | undefined;
    if (!proto || !wrapper.metatype) continue;
    const base = (Reflect.getMetadata(PATH_METADATA, wrapper.metatype) as string | string[] | undefined) ?? '';
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined) ?? '';
      out.push(`${METHODS[method]} ${join(String(base), String(path))}`);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : 1));
}
