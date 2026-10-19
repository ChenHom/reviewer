import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Controller("reports")
export class ReportsController {
  @UseGuards(
    AuthGuard("jwt"),
  )
  @Get(":id")
  find(id: string) {
    // 保持原樣
    const result = { id, kind: "daily" };
    return result;
  }
}
