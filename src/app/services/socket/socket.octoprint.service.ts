import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import _ from 'lodash-es';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import { pluck, startWith } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { ConversionService } from 'src/app/conversion.service';
import { PrinterEvent } from 'src/app/model/event.model';
import { DisplayLayerProgressData } from 'src/app/model/octoprint/plugins/display-layer-progress.model';

import { ConfigService } from '../../config/config.service';
import { JobStatus, PrinterState, PrinterStatus, SocketAuth } from '../../model';
import {
  OctoprintFilament,
  OctoprintPluginMessage,
  OctoprintSocketCurrent,
  OctoprintSocketEvent,
} from '../../model/octoprint/socket.model';
import { SystemService } from '../system/system.service';
import { SocketService } from './socket.service';

@Injectable()
export class OctoPrintSocketService implements SocketService {
  private fastInterval = 0;
  private socket: WebSocketSubject<unknown>;

  private printerStatusSubject: Subject<PrinterStatus>;
  private jobStatusSubject: Subject<JobStatus>;
  private eventSubject: Subject<PrinterEvent>;

  private printerStatus: PrinterStatus;
  private jobStatus: JobStatus;
  private lastState: PrinterEvent;

  public constructor(
    private configService: ConfigService,
    private systemService: SystemService,
    private conversionService: ConversionService,
    private http: HttpClient,
  ) {
    this.printerStatusSubject = new ReplaySubject<PrinterStatus>();
    this.jobStatusSubject = new ReplaySubject<JobStatus>();
    this.eventSubject = new ReplaySubject<PrinterEvent>();
  }

  //==== SETUP & AUTH ====//

  public connect(): Promise<void> {
    this.initPrinterStatus();
    this.initJobStatus();

    return new Promise(resolve => {
      this.tryConnect(resolve);
    });
  }

  private initPrinterStatus(): void {
    this.printerStatus = {
      status: PrinterState.connecting,
      bed: {
        current: 0,
        set: 0,
        unit: '°C',
      },
      tool0: {
        current: 0,
        set: 0,
        unit: '°C',
      },
      fanSpeed: this.configService.isDisplayLayerProgressEnabled() ? 0 : -1,
    } as PrinterStatus;
  }

  private initJobStatus(): void {
    this.jobStatus = {
      file: null,
      thumbnail: null,
      progress: 0,
      zHeight: this.configService.isDisplayLayerProgressEnabled() ? { current: 0, total: -1 } : 0,
      filamentAmount: 0,
      timePrinted: null,
      timeLeft: {
        value: '---',
        unit: null,
      },
      estimatedPrintTime: null,
      estimatedEndTime: null,
    };
  }

  private tryConnect(resolve: () => void): void {
    this.systemService.getSessionKey().subscribe(
      socketAuth => {
        this.connectSocket();
        this.setupSocket(resolve);
        this.authenticateSocket(socketAuth);
      },
      () => {
        setTimeout(this.tryConnect.bind(this), this.fastInterval < 6 ? 5000 : 15000, resolve);
        this.fastInterval += 1;
      },
    );
  }

  private connectSocket() {
    const url = `${this.configService.getApiURL('sockjs/websocket', false).replace(/^http/, 'ws')}`;
    if (!this.socket) {
      this.socket = webSocket(url);
    }
  }

  private authenticateSocket(socketAuth: SocketAuth) {
    const payload = {
      auth: `${socketAuth.user}:${socketAuth.session}`,
    };
    this.socket.next(payload);
  }

  private setupSocket(resolve: () => void) {
    this.socket.subscribe(message => {
      if (Object.hasOwnProperty.bind(message)('current')) {
        this.extractPrinterStatus(message as OctoprintSocketCurrent);
        this.extractJobStatus(message as OctoprintSocketCurrent);
      } else if (Object.hasOwnProperty.bind(message)('event')) {
        this.extractPrinterEvent(message as OctoprintSocketEvent);
      } else if (Object.hasOwnProperty.bind(message)('plugin')) {
        const pluginMessage = message as OctoprintPluginMessage;
        if (
          pluginMessage.plugin.plugin === 'DisplayLayerProgress-websocket-payload' &&
          this.configService.isDisplayLayerProgressEnabled()
        ) {
          this.extractFanSpeed(pluginMessage.plugin.data as DisplayLayerProgressData);
          this.extractLayerHeight(pluginMessage.plugin.data as DisplayLayerProgressData);
        }
      } else if (Object.hasOwnProperty.bind(message)('reauth')) {
        console.log('REAUTH REQUIRED');
      } else if (Object.hasOwnProperty.bind(message)('connected')) {
        resolve();
        this.checkPrinterConnection();
      }
    });
  }

  private checkPrinterConnection() {
    this.http
      .get(this.configService.getApiURL('connection'), this.configService.getHTTPHeaders())
      .pipe(pluck('current'), pluck('state'))
      .subscribe((state: string) => {
        if (state === 'Closed' || state === 'Error') {
          this.eventSubject.next(PrinterEvent.CLOSED);
        }
      });
  }

  //==== Printer Status ====//

  public extractPrinterStatus(message: OctoprintSocketCurrent): void {
    if (message.current.temps[0]) {
      this.printerStatus.bed = {
        current: Math.round(message?.current?.temps[0]?.bed?.actual),
        set: Math.round(message?.current?.temps[0]?.bed?.target),
        unit: '°C',
      };
      this.printerStatus.tool0 = {
        current: Math.round(message?.current?.temps[0]?.tool0?.actual),
        set: Math.round(message?.current?.temps[0]?.tool0?.target),
        unit: '°C',
      };
    }
    this.printerStatus.status = PrinterState[message.current.state.text.toLowerCase()];

    this.printerStatusSubject.next(this.printerStatus);
  }

  public extractFanSpeed(message: DisplayLayerProgressData): void {
    this.printerStatus.fanSpeed = Number(message.fanspeed.replace('%', '').trim());
  }

  //==== Job Status ====//

  public extractJobStatus(message: OctoprintSocketCurrent): void {
    const file = message?.current?.job?.file?.display?.replace('.gcode', '').replace('.ufp', '');
    if (this.jobStatus.file !== file) {
      this.initJobStatus();
    }

    this.jobStatus.file = file;
    this.jobStatus.thumbnail = null; //TODO
    this.jobStatus.progress = Math.round(message?.current?.progress?.completion);
    this.jobStatus.timePrinted = {
      value: this.conversionService.convertSecondsToHours(message.current.progress.printTime),
      unit: 'h',
    };

    if (message.current.job.filament) {
      this.jobStatus.filamentAmount = this.getTotalFilamentWeight(message.current.job.filament);
    }

    if (message.current.progress.printTimeLeft) {
      this.jobStatus.timeLeft = {
        value: this.conversionService.convertSecondsToHours(message.current.progress.printTimeLeft),
        unit: 'h',
      };
      this.jobStatus.estimatedEndTime = this.calculateEndTime(message.current.progress.printTimeLeft);
    }

    if (message.current.job.estimatedPrintTime) {
      this.jobStatus.estimatedPrintTime = {
        value: this.conversionService.convertSecondsToHours(message.current.job.estimatedPrintTime),
        unit: 'h',
      };
    }

    if (!this.configService.isDisplayLayerProgressEnabled() && message.current.currentZ) {
      this.jobStatus.zHeight = message.current.currentZ;
    }

    this.jobStatusSubject.next(this.jobStatus);
  }

  private getTotalFilamentWeight(filament: OctoprintFilament) {
    let filamentLength = 0;
    _.forEach(filament, (tool): void => {
      filamentLength += tool.length;
    });
    return this.conversionService.convertFilamentLengthToWeight(filamentLength);
  }

  private calculateEndTime(printTimeLeft: number) {
    const date = new Date();
    date.setSeconds(date.getSeconds() + printTimeLeft);
    return `${('0' + date.getHours()).slice(-2)}:${('0' + date.getMinutes()).slice(-2)}`;
  }

  public extractLayerHeight(message: DisplayLayerProgressData): void {
    this.jobStatus.zHeight = {
      current: Number(message.currentLayer),
      total: Number(message.totalLayer),
    };
  }

  //==== Event ====//

  public extractPrinterEvent(state: OctoprintSocketEvent): void {
    let newState: PrinterEvent;

    switch (state.event.type) {
      case 'PrintStarted' || 'PrintResumed':
        newState = PrinterEvent.PRINTING;
        break;
      case 'PrintPaused':
        newState = PrinterEvent.PAUSED;
        break;
      case 'PrintFailed' || 'PrintDone' || 'PrintCancelled' || 'Connected':
        newState = PrinterEvent.IDLE;
        break;
      case 'Connected':
        newState = PrinterEvent.CONNECTED;
        break;
      case 'Disconnected':
        newState = PrinterEvent.CLOSED;
        break;
      case 'Error':
        newState = PrinterEvent.CLOSED;
        break;
      default:
        console.log('FALLTHROUGH');
        console.log(state);
        break;
    }

    if (this.printerStatus.status === PrinterState.printing && this.lastState !== PrinterEvent.PRINTING) {
      newState = PrinterEvent.PRINTING;
    } else if (this.printerStatus.status === PrinterState.paused && this.lastState !== PrinterEvent.PAUSED) {
      newState = PrinterEvent.PAUSED;
    }

    if (newState) {
      this.lastState = newState;
      this.eventSubject.next(newState);
    }
  }

  //==== Subscribables ====//

  public getPrinterStatusSubscribable(): Observable<PrinterStatus> {
    return this.printerStatusSubject.pipe(startWith(this.printerStatus));
  }

  public getJobStatusSubscribable(): Observable<JobStatus> {
    return this.jobStatusSubject.pipe(startWith(this.jobStatus));
  }

  public getEventSubscribable(): Observable<PrinterEvent> {
    return this.eventSubject;
  }
}
