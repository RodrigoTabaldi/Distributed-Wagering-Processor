import { Controller, Get } from '@nestjs/common';
import { Public } from './auth.module.js';
import { openApi } from './openapi.js';

@Public()
@Controller('openapi.json')
export class DocsController {
  // Documento importável no Swagger Editor/Postman; não depende de serviço externo para funcionar.
  @Get()
  document() {
    return openApi;
  }
}
