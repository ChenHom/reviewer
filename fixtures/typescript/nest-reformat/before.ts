import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Controller('reports')
export class ReportsController {
  @UseGuards(AuthGuard('jwt'))
  @Get(':id')
  find(id: string) {
    const report = { id, kind: 'daily' };
    return report;
  }
}
